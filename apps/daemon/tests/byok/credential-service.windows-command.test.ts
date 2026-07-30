import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnState = vi.hoisted(() => ({
  closeOnStdinFinish: true,
  inputs: [] as string[],
  kills: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>;
        stderr: PassThrough;
        stdin: PassThrough;
        stdout: PassThrough;
      };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => true);
      spawnState.kills.push(child.kill);

      const input: Buffer[] = [];
      child.stdin.on('data', (chunk: Buffer) => input.push(chunk));
      child.stdin.on('finish', () => {
        spawnState.inputs.push(Buffer.concat(input).toString('utf8'));
        if (spawnState.closeOnStdinFinish) {
          queueMicrotask(() => child.emit('close', 0));
        }
      });
      return child;
    }),
  };
});

import { createPlatformByokSecretBackend } from '../../src/byok/credential-service.js';

const spawnMock = vi.mocked(spawn);

describe('Windows DPAPI command boundary', () => {
  afterEach(() => {
    spawnMock.mockClear();
    spawnState.closeOnStdinFinish = true;
    spawnState.inputs.length = 0;
    spawnState.kills.length = 0;
    vi.useRealTimers();
  });

  it('frames the secret as one base64 line so PowerShell does not wait for pipe EOF', async () => {
    const backend = createPlatformByokSecretBackend('win32', 'C:\\open-design-data');
    const secret = 'sk-test-secret-with-unicode-密钥';

    await backend.set('byok-windows-command', secret);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe('powershell.exe');
    const encodedCommand = args?.at(-1);
    expect(typeof encodedCommand).toBe('string');
    const script = Buffer.from(encodedCommand as string, 'base64').toString('utf16le');
    expect(script).toContain('[Console]::In.ReadLine()');
    expect(script).not.toContain('[Console]::In.ReadToEnd()');
    expect(spawnState.inputs).toEqual([
      `${Buffer.from(secret, 'utf8').toString('base64')}\n`,
    ]);
  });

  it('terminates a DPAPI helper that does not exit', async () => {
    vi.useFakeTimers();
    spawnState.closeOnStdinFinish = false;
    const backend = createPlatformByokSecretBackend('win32', 'C:\\open-design-data');

    const result = backend.set('byok-windows-timeout', 'sk-timeout-secret');
    const rejection = expect(result).rejects.toThrow(
      'Secure credential backend command failed.',
    );

    await vi.advanceTimersByTimeAsync(9_999);
    expect(spawnState.kills[0]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(spawnState.kills[0]).toHaveBeenCalledTimes(1);
  });
});
