import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createVelaWalletSnapshotReader } from '../../src/integrations/vela-wallet.js';

let originalHome: string | undefined;
let testHome: string;

function seedWalletLogin(): void {
  const configFile = path.join(testHome, '.amr', 'config.json');
  mkdirSync(path.dirname(configFile), { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      profiles: {
        local: {
          apiUrl: 'https://wallet.example.test',
          controlKey: 'ck-wallet-unit',
          runtimeKey: 'rt-wallet-unit',
          user: {
            id: 'wallet-unit-user',
            email: 'wallet-unit@example.com',
            plan: 'plus',
          },
        },
      },
    }),
    'utf8',
  );
}

beforeEach(() => {
  originalHome = process.env.HOME;
  testHome = mkdtempSync(path.join(tmpdir(), 'od-vela-wallet-'));
  process.env.HOME = testHome;
  process.env.OPEN_DESIGN_AMR_PROFILE = 'local';
  seedWalletLogin();
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  delete process.env.OPEN_DESIGN_AMR_PROFILE;
  rmSync(testHome, { recursive: true, force: true });
});

describe('createVelaWalletSnapshotReader', () => {
  it('honors its TTL and lets an explicit refresh bypass a fresh cache entry', async () => {
    let nowMs = Date.parse('2026-07-31T02:00:00.000Z');
    let balanceUsd = '20.00';
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ balanceUsd }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const reader = createVelaWalletSnapshotReader({
      fetch: fetchMock as typeof fetch,
      now: () => new Date(nowMs),
      ttlMs: 100,
    });

    const initial = await reader.read();
    balanceUsd = '30.00';
    nowMs += 99;
    const cached = await reader.read();
    nowMs += 2;
    const expired = await reader.read();
    balanceUsd = '40.00';
    const forced = await reader.read({ refresh: true });

    expect(initial).toMatchObject({ balanceUsd: '20.00', source: 'vela_api' });
    expect(cached).toMatchObject({ balanceUsd: '20.00', source: 'daemon_cache' });
    expect(expired).toMatchObject({ balanceUsd: '30.00', source: 'vela_api' });
    expect(forced).toMatchObject({ balanceUsd: '40.00', source: 'vela_api' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { label: 'missing', body: {} },
    { label: 'numeric', body: { balanceUsd: 20 } },
    { label: 'negative', body: { balanceUsd: '-1.00' } },
    { label: 'NaN', body: { balanceUsd: 'NaN' } },
    { label: 'infinite', body: { balanceUsd: 'Infinity' } },
  ])('rejects a $label balance without overwriting the last valid snapshot', async ({ body }) => {
    let responseBody: unknown = { balanceUsd: '20.00' };
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const reader = createVelaWalletSnapshotReader({
      fetch: fetchMock as typeof fetch,
      ttlMs: 60_000,
    });

    const initial = await reader.read();
    responseBody = body;
    const rejected = await reader.read({ refresh: true });
    const cached = await reader.read();

    expect(initial).toMatchObject({ balanceUsd: '20.00', source: 'vela_api' });
    expect(rejected).toMatchObject({
      balanceUsd: '20.00',
      source: 'daemon_cache',
      stale: true,
      error: { code: 'upstream' },
    });
    expect(cached).toMatchObject({
      balanceUsd: '20.00',
      source: 'daemon_cache',
      stale: false,
    });
    expect(cached.error).toBeUndefined();
  });

  it('keeps the last valid snapshot when the upstream returns malformed JSON', async () => {
    let malformed = false;
    const fetchMock = vi.fn(async () =>
      new Response(malformed ? '{"balanceUsd":' : JSON.stringify({ balanceUsd: '20.00' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const reader = createVelaWalletSnapshotReader({
      fetch: fetchMock as typeof fetch,
      ttlMs: 60_000,
    });

    await reader.read();
    malformed = true;
    const degraded = await reader.read({ refresh: true });

    expect(degraded).toMatchObject({
      balanceUsd: '20.00',
      source: 'daemon_cache',
      stale: true,
      error: { code: 'network' },
    });
  });
});
