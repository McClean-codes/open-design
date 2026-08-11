import { describe, expect, it } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import { createWorkspaceExactContextCache } from '../../src/collab/workspace-exact-context-cache.js';

const context = (workspaceId: string): WorkspaceCollabContext =>
  ({ workspaceId, workspaceMemberId: `member-${workspaceId}` }) as WorkspaceCollabContext;

describe('workspace exact context cache', () => {
  it('never caches in legacy health and reuses only a healthy exact scope', async () => {
    let calls = 0;
    const cache = createWorkspaceExactContextCache({
      identity: () => 'account-a',
      provider: {
        current: async () => null,
        resolveExact: async ({ workspaceId }) => {
          calls += 1;
          return context(workspaceId);
        },
      },
    });

    await cache.provider.resolveExact?.({ workspaceId: 'w1' });
    await cache.provider.resolveExact?.({ workspaceId: 'w1' });
    expect(calls).toBe(2);

    cache.setRealtimeHealthy('w1', true);
    await cache.provider.resolveExact?.({ workspaceId: 'w1' });
    expect(calls).toBe(2);
    await cache.provider.resolveExact?.({ workspaceId: 'w2' });
    expect(calls).toBe(3);
  });

  it('invalidates on health loss and cannot cross a credential identity', async () => {
    let identity = 'account-a';
    let calls = 0;
    const cache = createWorkspaceExactContextCache({
      identity: () => identity,
      provider: {
        current: async () => null,
        resolveExact: async ({ workspaceId }) => {
          calls += 1;
          return context(workspaceId);
        },
      },
    });

    await cache.refresh({ workspaceId: 'w1' });
    cache.setRealtimeHealthy('w1', true);
    expect(cache.cached('w1')).toMatchObject({ workspaceId: 'w1' });

    identity = 'account-b';
    expect(cache.cached('w1')).toBeNull();
    await cache.provider.resolveExact?.({ workspaceId: 'w1' });
    expect(calls).toBe(2);

    cache.setRealtimeHealthy('w1', false);
    expect(cache.cached('w1')).toBeNull();
  });

  it('does not let a pre-invalidation response seed the next generation', async () => {
    let resolve!: (value: WorkspaceCollabContext) => void;
    const held = new Promise<WorkspaceCollabContext>((done) => {
      resolve = done;
    });
    const cache = createWorkspaceExactContextCache({
      identity: () => 'account-a',
      provider: {
        current: async () => null,
        resolveExact: async () => held,
      },
    });

    const old = cache.refresh({ workspaceId: 'w1' });
    cache.invalidate('w1');
    resolve(context('w1'));
    await old;
    cache.setRealtimeHealthy('w1', true);
    expect(cache.cached('w1')).toBeNull();
  });
});
