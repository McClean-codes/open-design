import type { Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ByokCredentialService,
  type ByokSecretBackend,
} from '../../src/byok/credential-service.js';
import {
  startServer,
  type StartServerResult,
} from '../../src/server.js';

class ShutdownTestBackend implements ByokSecretBackend {
  readonly kind = 'shutdown-test';

  async available() {
    return true;
  }

  async close() {}

  async set() {}

  async get() {
    return null;
  }

  async delete() {
    return false;
  }
}

describe('daemon BYOK shutdown ownership', () => {
  let server: Server | undefined;
  let releaseClose: (() => void) | undefined;

  afterEach(async () => {
    releaseClose?.();
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
    server = undefined;
    releaseClose = undefined;
  });

  it('shares one shutdown promise and waits for the credential worker owner to close', async () => {
    const service = new ByokCredentialService({
      dataDir: '/test/byok-shutdown',
      backend: new ShutdownTestBackend(),
    });
    let closeStarted: (() => void) | undefined;
    const closeObserved = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    service.close = vi.fn(async () => {
      closeStarted?.();
      await closeGate;
    });
    const started = await startServer({
      byokCredentialService: service,
      port: 0,
      returnServer: true,
    }) as StartServerResult;
    server = started.server;

    const firstShutdown = started.shutdown() as Promise<void>;
    const secondShutdown = started.shutdown() as Promise<void>;
    expect(secondShutdown).toBe(firstShutdown);
    await closeObserved;

    let settled = false;
    void firstShutdown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseClose?.();
    await expect(Promise.all([firstShutdown, secondShutdown])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(service.close).toHaveBeenCalledTimes(1);
  });

  it('closes the credential worker owner when the HTTP server closes first', async () => {
    const service = new ByokCredentialService({
      dataDir: '/test/byok-server-close',
      backend: new ShutdownTestBackend(),
    });
    service.close = vi.fn(async () => undefined);
    const started = await startServer({
      byokCredentialService: service,
      port: 0,
      returnServer: true,
    }) as StartServerResult;
    server = started.server;

    await new Promise<void>((resolve, reject) => {
      started.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await vi.waitFor(() => {
      expect(service.close).toHaveBeenCalledTimes(1);
    });
  });
});
