import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  WindowsDpapiBackend,
  type WindowsDpapiBackendOptions,
} from '../../src/byok/credential-service.js';
import type {
  WindowsDpapiWorkerDiagnostic,
  WindowsDpapiWorkerResult,
} from '../../src/byok/windows-dpapi-worker.js';
import { WindowsDpapiWorkerError } from '../../src/byok/windows-dpapi-worker.js';

type WorkerOperation = 'set' | 'get' | 'delete';

type FakeWorker = {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  ready: ReturnType<typeof vi.fn<() => Promise<void>>>;
  run: ReturnType<
    typeof vi.fn<
      (
        operation: WorkerOperation,
        secretPath: string,
        secret?: string,
      ) => Promise<WindowsDpapiWorkerResult>
    >
  >;
};

function createWorker(
  run: FakeWorker['run'] = vi.fn(async () => ({ found: true, value: null })),
): FakeWorker {
  return {
    close: vi.fn(async () => undefined),
    ready: vi.fn(async () => undefined),
    run,
  };
}

function backendOptions(
  input: WindowsDpapiBackendOptions & {
    onDiagnostic?: (diagnostic: WindowsDpapiWorkerDiagnostic) => void;
  },
): WindowsDpapiBackendOptions {
  return input as WindowsDpapiBackendOptions;
}

describe('Windows DPAPI backend worker lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not permanently cache an initial worker creation failure', async () => {
    const healthyWorker = createWorker();
    const createWorkerClient = vi.fn()
      .mockRejectedValueOnce(new Error('first worker failed'))
      .mockResolvedValueOnce(healthyWorker);
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: createWorkerClient,
    });

    await expect(backend.available()).resolves.toBe(false);
    await expect(backend.available()).resolves.toBe(true);

    expect(createWorkerClient).toHaveBeenCalledTimes(2);
    expect(healthyWorker.ready).toHaveBeenCalledTimes(1);
  });

  it('does not permanently cache a rejected PowerShell availability probe', async () => {
    const worker = createWorker();
    const commandAvailable = vi.fn()
      .mockRejectedValueOnce(new Error('transient command probe failure'))
      .mockResolvedValueOnce(true);
    const createWorkerClient = vi.fn(async () => worker);
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable,
      createWorker: createWorkerClient,
    });

    await expect(backend.available()).resolves.toBe(false);
    await expect(backend.available()).resolves.toBe(true);

    expect(commandAvailable).toHaveBeenCalledTimes(2);
    expect(createWorkerClient).toHaveBeenCalledTimes(1);
    expect(worker.ready).toHaveBeenCalledTimes(1);
  });

  it('fails the current operation once and rebuilds only for the next independent request', async () => {
    const failedWorker = createWorker(
      vi.fn(async () => {
        throw new Error('worker exited');
      }),
    );
    const healthyWorker = createWorker(
      vi.fn(async (operation) => ({
        found: operation === 'get',
        value: operation === 'get' ? 'recovered-secret' : null,
      })),
    );
    const createWorkerClient = vi.fn()
      .mockResolvedValueOnce(failedWorker)
      .mockResolvedValueOnce(healthyWorker);
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: createWorkerClient,
    });

    await expect(backend.set('byok-worker-recovery', 'do-not-replay')).rejects.toThrow(
      'Secure credential backend command failed.',
    );
    expect(failedWorker.run).toHaveBeenCalledTimes(1);
    expect(createWorkerClient).toHaveBeenCalledTimes(1);

    await expect(backend.get('byok-worker-recovery')).resolves.toBe('recovered-secret');

    expect(failedWorker.close).toHaveBeenCalledTimes(1);
    expect(createWorkerClient).toHaveBeenCalledTimes(2);
    expect(healthyWorker.run).toHaveBeenCalledTimes(1);
  });

  it('emits only allowlisted diagnostics and never includes the secret or secret path', async () => {
    const secret = 'diagnostic-must-not-leak-this-secret';
    const diagnostics: WindowsDpapiWorkerDiagnostic[] = [];
    const failedWorker = createWorker(
      vi.fn(async () => {
        throw new Error(`unsafe child detail ${secret} /test/byok/secrets/profile.bin`);
      }),
    );
    const backend = new WindowsDpapiBackend(
      '/test/byok/secrets',
      backendOptions({
        commandAvailable: async () => true,
        createWorker: async () => failedWorker,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    await expect(backend.set('byok-worker-diagnostics', secret)).rejects.toThrow(
      'Secure credential backend command failed.',
    );

    expect(diagnostics).toHaveLength(1);
    expect(Object.keys(diagnostics[0] ?? {}).sort()).toEqual([
      'durationMs',
      'failureClass',
      'phase',
      'workerGeneration',
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(JSON.stringify(diagnostics)).not.toContain('/test/byok/secrets');
  });

  it('bounds worker creation and closes a late generation without evicting the replacement', async () => {
    vi.useFakeTimers();
    let resolveFirstWorker: ((worker: FakeWorker) => void) | undefined;
    const lateWorker = createWorker();
    const healthyWorker = createWorker(
      vi.fn(async () => ({ found: true, value: 'healthy-secret' })),
    );
    const createWorkerClient = vi.fn()
      .mockImplementationOnce(() => new Promise<FakeWorker>((resolve) => {
        resolveFirstWorker = resolve;
      }))
      .mockResolvedValueOnce(healthyWorker);
    const diagnostics: WindowsDpapiWorkerDiagnostic[] = [];
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: createWorkerClient,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      timeouts: {
        startupMs: 10,
        readyMs: 10,
        operationMs: 10,
        shutdownMs: 10,
      },
    });

    const firstAvailability = backend.available();
    await vi.advanceTimersByTimeAsync(21);
    await expect(firstAvailability).resolves.toBe(false);
    await expect(backend.available()).resolves.toBe(true);

    resolveFirstWorker?.(lateWorker);
    await vi.advanceTimersByTimeAsync(0);

    expect(lateWorker.close).toHaveBeenCalledTimes(1);
    await expect(backend.get('byok-worker-generation')).resolves.toBe('healthy-secret');
    expect(createWorkerClient).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual([
      {
        phase: 'spawn',
        failureClass: 'timeout',
        durationMs: 10,
        workerGeneration: 1,
      },
      {
        phase: 'shutdown',
        failureClass: 'timeout',
        durationMs: 10,
        workerGeneration: 1,
      },
    ]);
  });

  it('bounds the ready phase and rebuilds on the next availability probe', async () => {
    vi.useFakeTimers();
    const stalledWorker = createWorker();
    stalledWorker.ready.mockImplementation(() => new Promise<void>(() => undefined));
    const healthyWorker = createWorker();
    const createWorkerClient = vi.fn()
      .mockResolvedValueOnce(stalledWorker)
      .mockResolvedValueOnce(healthyWorker);
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: createWorkerClient,
      timeouts: {
        startupMs: 10,
        readyMs: 10,
        operationMs: 10,
        shutdownMs: 10,
      },
    });

    const firstAvailability = backend.available();
    await vi.advanceTimersByTimeAsync(10);
    await expect(firstAvailability).resolves.toBe(false);
    await expect(backend.available()).resolves.toBe(true);

    expect(stalledWorker.close).toHaveBeenCalledTimes(1);
    expect(createWorkerClient).toHaveBeenCalledTimes(2);
  });

  it('bounds an operation, does not replay it, and rebuilds for the next request', async () => {
    vi.useFakeTimers();
    const stalledWorker = createWorker(
      vi.fn(() => new Promise<WindowsDpapiWorkerResult>(() => undefined)),
    );
    const healthyWorker = createWorker(
      vi.fn(async () => ({ found: true, value: 'after-timeout' })),
    );
    const createWorkerClient = vi.fn()
      .mockResolvedValueOnce(stalledWorker)
      .mockResolvedValueOnce(healthyWorker);
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: createWorkerClient,
      timeouts: {
        startupMs: 10,
        readyMs: 10,
        operationMs: 10,
        shutdownMs: 10,
      },
    });

    const timedOutSet = backend.set('byok-worker-operation-timeout', 'do-not-replay');
    const rejection = expect(timedOutSet).rejects.toThrow(
      'Secure credential backend command failed.',
    );
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(stalledWorker.run).toHaveBeenCalledTimes(1);
    await expect(backend.get('byok-worker-operation-timeout')).resolves.toBe('after-timeout');
    expect(createWorkerClient).toHaveBeenCalledTimes(2);
  });

  it('keeps a healthy worker after a non-fatal DPAPI operation error', async () => {
    const worker = createWorker(
      vi.fn()
        .mockRejectedValueOnce(new WindowsDpapiWorkerError('operation', 'dpapi', false))
        .mockResolvedValueOnce({ found: true, value: 'still-healthy' }),
    );
    const createWorkerClient = vi.fn(async () => worker);
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: createWorkerClient,
    });

    await expect(backend.set('byok-worker-dpapi-error', 'secret')).rejects.toThrow(
      'Secure credential backend command failed.',
    );
    await expect(backend.get('byok-worker-dpapi-error')).resolves.toBe('still-healthy');

    expect(createWorkerClient).toHaveBeenCalledTimes(1);
    expect(worker.close).not.toHaveBeenCalled();
  });

  it('closes the owned worker once and rejects new operations after shutdown starts', async () => {
    const worker = createWorker();
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: async () => worker,
    });
    await expect(backend.available()).resolves.toBe(true);

    await expect(Promise.all([backend.close(), backend.close()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    await expect(backend.available()).resolves.toBe(false);
    await expect(backend.get('byok-worker-after-close')).rejects.toMatchObject({
      phase: 'operation',
      failureClass: 'closed',
    });

    expect(worker.close).toHaveBeenCalledTimes(1);
  });

  it('propagates and diagnoses a bounded shutdown timeout without leaking worker details', async () => {
    vi.useFakeTimers();
    const diagnostics: WindowsDpapiWorkerDiagnostic[] = [];
    const worker = createWorker();
    worker.close.mockImplementation(() => new Promise<void>(() => undefined));
    const backend = new WindowsDpapiBackend('/test/byok/secrets', {
      commandAvailable: async () => true,
      createWorker: async () => worker,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      timeouts: { shutdownMs: 10 },
    });
    await expect(backend.available()).resolves.toBe(true);

    const close = backend.close();
    const rejection = expect(close).rejects.toMatchObject({
      message: 'Secure credential backend command failed.',
      phase: 'shutdown',
      failureClass: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(10);
    await rejection;

    expect(diagnostics).toEqual([
      {
        phase: 'shutdown',
        failureClass: 'timeout',
        durationMs: 10,
        workerGeneration: 1,
      },
    ]);
  });
});
