import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Duplex, PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WindowsDpapiWorker,
  WindowsDpapiWorkerError,
} from '../../src/byok/windows-dpapi-worker.js';

type FakeChild = ChildProcessWithoutNullStreams & {
  emitClose(code?: number | null): void;
  kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals | number) => boolean>>;
};

type WorkerHarness = {
  child: FakeChild;
  inject(line: string): void;
  pipe: Socket;
  worker: WindowsDpapiWorker;
  writes: string[];
};

function createFakeChild({ exitOnKill = true }: { exitOnKill?: boolean } = {}): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    emitClose: (_code?: number | null) => undefined,
    kill: vi.fn<(signal?: NodeJS.Signals | number) => boolean>(),
  });
  child.emitClose = (code = 0) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.emit('close', code, null);
  };
  child.kill = vi.fn(() => {
    child.killed = true;
    if (exitOnKill) queueMicrotask(() => child.emitClose(1));
    return true;
  });
  return child as unknown as FakeChild;
}

function createHarness({
  exitOnKill = true,
  exitOnPipeEnd = false,
  onWrite,
  shutdownTimeoutMs = 10,
}: {
  exitOnKill?: boolean;
  exitOnPipeEnd?: boolean;
  onWrite?: (line: string, harness: WorkerHarness) => void;
  shutdownTimeoutMs?: number;
} = {}): WorkerHarness {
  const child = createFakeChild({ exitOnKill });
  const writes: string[] = [];
  let harness: WorkerHarness;
  const pipe = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      const line = chunk.toString('utf8');
      writes.push(line);
      onWrite?.(line, harness);
      callback();
    },
    final(callback) {
      if (exitOnPipeEnd) queueMicrotask(() => child.emitClose(0));
      callback();
    },
  }) as Socket;
  const worker = WindowsDpapiWorker.fromConnectedTransport(child, pipe, {
    shutdownTimeoutMs,
  });
  harness = {
    child,
    inject(line) {
      pipe.push(Buffer.from(line, 'utf8'));
    },
    pipe,
    worker,
    writes,
  };
  return harness;
}

function ready(harness: WorkerHarness): Promise<void> {
  harness.inject('{"type":"ready","ok":true}\n');
  return harness.worker.ready();
}

function parsedRequest(line: string): {
  id: string;
  operation: 'set' | 'get' | 'delete';
} {
  return JSON.parse(line) as {
    id: string;
    operation: 'set' | 'get' | 'delete';
  };
}

describe('Windows DPAPI worker protocol and lifecycle', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    return Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('bounds the pipe connection phase, terminates the child, and passes only a parent PID watchdog input', async () => {
    vi.useFakeTimers();
    const root = await mkdtemp(path.join(tmpdir(), 'od-dpapi-worker-connect-'));
    roots.push(root);
    const child = createFakeChild();
    let observeSpawn: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      observeSpawn = resolve;
    });
    let spawnEnvironment: NodeJS.ProcessEnv | undefined;
    const creating = WindowsDpapiWorker.create({
      connectTimeoutMs: 10,
      pipeAddress: {
        connectionName: path.join(root, 'worker.sock'),
        listenPath: path.join(root, 'worker.sock'),
      },
      spawnWorker: (_command, _args, options) => {
        spawnEnvironment = options.env;
        observeSpawn?.();
        return child;
      },
    });
    const rejection = expect(creating).rejects.toMatchObject({
      phase: 'connect',
      failureClass: 'timeout',
    });
    await spawned;
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawnEnvironment?.OD_BYOK_DPAPI_PARENT_PID).toBe(String(process.pid));
    expect(spawnEnvironment?.OD_BYOK_DPAPI_PIPE_NAME).toBe(
      path.join(root, 'worker.sock'),
    );
    expect(JSON.stringify(spawnEnvironment)).not.toContain('secretPath');
  });

  it('aborts an in-progress connection immediately during daemon shutdown', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-dpapi-worker-abort-'));
    roots.push(root);
    const child = createFakeChild();
    const abortController = new AbortController();
    let observeSpawn: (() => void) | undefined;
    const spawned = new Promise<void>((resolve) => {
      observeSpawn = resolve;
    });
    const creating = WindowsDpapiWorker.create({
      connectTimeoutMs: 50_000,
      pipeAddress: {
        connectionName: path.join(root, 'worker.sock'),
        listenPath: path.join(root, 'worker.sock'),
      },
      signal: abortController.signal,
      spawnWorker: () => {
        observeSpawn?.();
        return child;
      },
    });
    const rejection = expect(creating).rejects.toMatchObject({
      phase: 'shutdown',
      failureClass: 'closed',
      fatal: false,
    });
    await spawned;

    abortController.abort();
    await rejection;

    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects ready when the child exits before the handshake', async () => {
    const harness = createHarness();
    const readyResult = harness.worker.ready();
    harness.child.emitClose(1);

    await expect(readyResult).rejects.toMatchObject({
      message: 'Secure credential backend command failed.',
      phase: 'ready',
      failureClass: 'child-exit',
      fatal: true,
    });
  });

  it('fails a pending operation when the child exits', async () => {
    let requestWritten: (() => void) | undefined;
    const writeObserved = new Promise<void>((resolve) => {
      requestWritten = resolve;
    });
    const harness = createHarness({
      onWrite: () => requestWritten?.(),
    });
    await ready(harness);
    const result = harness.worker.run('get', '/secret/path');
    await writeObserved;
    harness.child.emitClose(1);

    await expect(result).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'child-exit',
      fatal: true,
    });
  });

  it('settles queued operations after a crash instead of leaving the queue hung', async () => {
    let requestWritten: (() => void) | undefined;
    const writeObserved = new Promise<void>((resolve) => {
      requestWritten = resolve;
    });
    const harness = createHarness({
      onWrite: () => requestWritten?.(),
    });
    await ready(harness);
    const inFlight = harness.worker.run('set', '/secret/path', 'secret');
    const queued = harness.worker.run('get', '/secret/path');
    const inFlightRejection = expect(inFlight).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'child-exit',
    });
    const queuedRejection = expect(queued).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'closed',
    });
    await writeObserved;

    harness.child.emitClose(1);

    await Promise.all([inFlightRejection, queuedRejection]);
    expect(harness.writes).toHaveLength(1);
  });

  it.each([
    ['malformed JSON', 'not-json\n'],
    ['response ID mismatch', '{"id":"wrong","ok":true,"found":false}\n'],
  ])('treats %s as a fatal protocol error', async (_label, response) => {
    const harness = createHarness({
      onWrite: () => queueMicrotask(() => harness.inject(response)),
    });
    await ready(harness);

    await expect(harness.worker.run('get', '/secret/path')).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'protocol',
      fatal: true,
    });
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized response line and terminates the worker', async () => {
    const harness = createHarness({
      onWrite: () => queueMicrotask(() => harness.inject('x'.repeat(64 * 1024 + 1))),
    });
    await ready(harness);

    await expect(harness.worker.run('get', '/secret/path')).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'protocol',
      fatal: true,
    });
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it('keeps the worker alive after a request-scoped DPAPI failure', async () => {
    let requests = 0;
    const harness = createHarness({
      onWrite: (line) => {
        const request = parsedRequest(line);
        requests += 1;
        queueMicrotask(() => {
          if (requests === 1) {
            harness.inject(`${JSON.stringify({ id: request.id, ok: false })}\n`);
          } else {
            harness.inject(`${JSON.stringify({
              id: request.id,
              ok: true,
              found: true,
              value: Buffer.from('recovered', 'utf8').toString('base64'),
            })}\n`);
          }
        });
      },
      exitOnPipeEnd: true,
    });
    await ready(harness);

    await expect(harness.worker.run('set', '/secret/path', 'secret')).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'dpapi',
      fatal: false,
    });
    await expect(harness.worker.run('get', '/secret/path')).resolves.toEqual({
      found: true,
      value: 'recovered',
    });
    expect(harness.child.kill).not.toHaveBeenCalled();
    await harness.worker.close();
  });

  it('rejects an oversized request before writing it and keeps the worker usable', async () => {
    const harness = createHarness({
      onWrite: (line) => {
        const request = parsedRequest(line);
        queueMicrotask(() => harness.inject(`${JSON.stringify({
          id: request.id,
          ok: true,
          found: false,
        })}\n`));
      },
      exitOnPipeEnd: true,
    });
    await ready(harness);

    await expect(
      harness.worker.run('get', `/secret/${'x'.repeat(64 * 1024)}`),
    ).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'input',
      fatal: false,
    });
    await expect(harness.worker.run('get', '/secret/path')).resolves.toEqual({
      found: false,
      value: null,
    });

    expect(harness.writes).toHaveLength(1);
    expect(harness.child.kill).not.toHaveBeenCalled();
    await harness.worker.close();
  });

  it('closes gracefully on pipe EOF and is idempotent', async () => {
    const harness = createHarness({ exitOnPipeEnd: true });
    await ready(harness);

    const firstClose = harness.worker.close();
    const secondClose = harness.worker.close();
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(harness.child.kill).not.toHaveBeenCalled();
  });

  it('force-terminates the owned child after the graceful shutdown budget', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ exitOnKill: true, shutdownTimeoutMs: 10 });
    await ready(harness);

    const close = harness.worker.close();
    await vi.advanceTimersByTimeAsync(10);
    await expect(close).resolves.toBeUndefined();

    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it('reports a bounded safe shutdown failure when the child ignores termination', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ exitOnKill: false, shutdownTimeoutMs: 10 });
    await ready(harness);

    const close = harness.worker.close();
    const rejection = expect(close).rejects.toEqual(
      expect.objectContaining({
        message: 'Secure credential backend command failed.',
        phase: 'shutdown',
        failureClass: 'timeout',
      }),
    );
    await vi.advanceTimersByTimeAsync(20);
    await rejection;

    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects non-canonical base64 without returning attacker-controlled bytes', async () => {
    const harness = createHarness({
      onWrite: (line) => {
        const request = parsedRequest(line);
        queueMicrotask(() => harness.inject(`${JSON.stringify({
          id: request.id,
          ok: true,
          found: true,
          value: '%%%%',
        })}\n`));
      },
    });
    await ready(harness);

    await expect(harness.worker.run('get', '/secret/path')).rejects.toBeInstanceOf(
      WindowsDpapiWorkerError,
    );
    expect(harness.child.kill).toHaveBeenCalledTimes(1);
  });
});
