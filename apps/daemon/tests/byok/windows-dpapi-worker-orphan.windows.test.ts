import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const describeWindows = describe.runIf(process.platform === 'win32');

describeWindows('Windows DPAPI worker orphan boundary', () => {
  const roots: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const workerPids = new Set<number>();

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const pid of workerPids) {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Exact owned PID cleanup only; already-exited workers are expected.
        }
      }
    }
    workerPids.clear();
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it('exits after its daemon parent is force-terminated without running shutdown handlers', {
    timeout: 60_000,
  }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-dpapi-orphan-'));
    roots.push(root);
    const fixturePath = path.join(root, 'worker-parent.mjs');
    const workerModuleUrl = pathToFileURL(
      path.resolve('src/byok/windows-dpapi-worker.ts'),
    ).href;
    await writeFile(
      fixturePath,
      [
        `import { WindowsDpapiWorker } from ${JSON.stringify(workerModuleUrl)};`,
        'const worker = await WindowsDpapiWorker.create();',
        'await worker.ready();',
        'process.stdout.write(`${JSON.stringify({ workerPid: worker.processId })}\\n`);',
        'setInterval(() => {}, 1_000);',
      ].join('\n'),
      'utf8',
    );
    const parent = spawn(process.execPath, ['--import', 'tsx', fixturePath], {
      cwd: path.resolve('.'),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    children.push(parent);
    parent.stdin.end();
    const firstLine = await readFirstLine(parent);
    const payload = JSON.parse(firstLine) as { workerPid?: unknown };
    expect(payload.workerPid).toEqual(expect.any(Number));
    const workerPid = Number(payload.workerPid);
    workerPids.add(workerPid);
    expect(isProcessAlive(workerPid)).toBe(true);

    parent.kill('SIGKILL');
    await waitForChildClose(parent, 5_000);
    await expect(waitForProcessExit(workerPid, 5_000)).resolves.toBe(true);
    workerPids.delete(workerPid);
  });
});

async function readFirstLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  let stdout = '';
  let stderr = '';
  const onStderr = (chunk: Buffer) => {
    if (stderr.length < 8_192) stderr += chunk.toString('utf8');
  };
  child.stderr.on('data', onStderr);
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Windows DPAPI worker parent did not become ready: ${stderr}`));
    }, 50_000);
    timeout.unref?.();
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      child.stdout.off('data', onStdout);
      resolve(stdout.slice(0, newline));
    };
    child.stdout.on('data', onStdout);
    child.once('close', (code) => {
      if (stdout.includes('\n')) return;
      clearTimeout(timeout);
      reject(new Error(`Windows DPAPI worker parent exited before ready (${code}): ${stderr}`));
    });
  });
}

async function waitForChildClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, 'close').then(() => undefined),
    new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error('parent process did not exit')), timeoutMs);
      timeout.unref?.();
    }),
  ]);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 100);
      timer.unref?.();
    });
  }
  return !isProcessAlive(pid);
}
