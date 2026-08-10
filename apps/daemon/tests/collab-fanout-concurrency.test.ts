// Every fan-out in the collab layer ends in a `vela` child process — one pull
// per shared resource, one push per dirty project. Both fan-outs are sized by
// user data (how much a workspace shares, how many projects a run touched), so
// an unbounded fan-out makes the daemon's peak subprocess count a property of
// the workspace instead of the machine. These specs pin the peak.

import { describe, expect, it, vi } from 'vitest';
import {
  COLLAB_VELA_FANOUT_CONCURRENCY,
  createTeamResourceListCache,
} from '../src/collab/team-resource-list-cache.js';
import { CollabPublishScheduler } from '../src/collab/publish-scheduler.js';
import type {
  TeamResourceRequestScope,
  TeamResourceShareRecord,
} from '../src/collab/team-resource-share.js';

const SCOPE: TeamResourceRequestScope = {
  principal: {
    memberId: 'wm-1',
    teamId: 'ws-1',
    role: 'owner',
    lifecycleState: 'active',
    workspaceType: 'team',
  },
  canShare: true,
};

function sharedResources(count: number): TeamResourceShareRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `user:res-${index}`,
    ownerMemberId: 'wm-owner',
  })) as TeamResourceShareRecord[];
}

/** Records the high-water mark of overlapping calls to the wrapped operation. */
function concurrencyProbe() {
  let active = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  return {
    get peak() {
      return peak;
    },
    get active() {
      return active;
    },
    /** Settle every operation currently parked inside the probe. */
    drain() {
      const parked = release.splice(0, release.length);
      for (const resolve of parked) resolve();
    },
    async run(): Promise<void> {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => release.push(resolve));
      active -= 1;
    },
  };
}

/** Let parked operations settle and their continuations run. */
async function settle(probe: ReturnType<typeof concurrencyProbe>, rounds: number) {
  for (let round = 0; round < rounds; round += 1) {
    probe.drain();
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe('shared team resource materialization fan-out', () => {
  it('never materializes more shared resources at once than the vela fan-out cap', async () => {
    const RESOURCE_COUNT = 60;
    const probe = concurrencyProbe();
    const list = createTeamResourceListCache({
      share: {
        sharedResources: async () => sharedResources(RESOURCE_COUNT),
      } as never,
      sync: () => probe.run(),
      invalidateSharedCommand: () => {},
    });

    const reading = list(SCOPE);
    // Let the listing resolve and the fan-out schedule whatever it will.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const peakBeforeAnySettles = probe.peak;
    await settle(probe, RESOURCE_COUNT + 2);
    const listing = await reading;

    expect(listing.ids).toHaveLength(RESOURCE_COUNT);
    expect(peakBeforeAnySettles).toBeLessThanOrEqual(COLLAB_VELA_FANOUT_CONCURRENCY);
    expect(probe.peak).toBeLessThanOrEqual(COLLAB_VELA_FANOUT_CONCURRENCY);
  });

  it('still materializes every shared resource exactly once', async () => {
    const seen: string[] = [];
    const list = createTeamResourceListCache({
      share: {
        sharedResources: async () => sharedResources(25),
      } as never,
      sync: async (resource) => {
        seen.push(resource.id);
      },
      invalidateSharedCommand: () => {},
    });

    const listing = await list(SCOPE);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(listing.ids).toEqual(seen.slice().sort((a, b) => seen.indexOf(a) - seen.indexOf(b)));
  });

  it('surfaces a failing materialization instead of swallowing it', async () => {
    const list = createTeamResourceListCache({
      share: {
        sharedResources: async () => sharedResources(8),
      } as never,
      sync: async (resource) => {
        if (resource.id === 'user:res-3') throw new Error('pull failed');
      },
      invalidateSharedCommand: () => {},
    });

    await expect(list(SCOPE)).rejects.toThrow('pull failed');
  });
});

describe('cross-project publish fan-out', () => {
  it('never publishes more projects at once than the vela fan-out cap', async () => {
    vi.useFakeTimers();
    try {
      const PROJECT_COUNT = 40;
      const probe = concurrencyProbe();
      const scheduler = new CollabPublishScheduler({
        adapter: { publish: () => probe.run().then(() => ({ version: 1 })) },
        debounceMs: 10,
      });

      for (let index = 0; index < PROJECT_COUNT; index += 1) {
        scheduler.notifyChanged(`p${index}`);
      }
      // Every project's debounce expires in the same tick — the worst case a
      // run boundary or a workspace-wide reconcile produces.
      await vi.advanceTimersByTimeAsync(10);

      expect(probe.peak).toBeLessThanOrEqual(COLLAB_VELA_FANOUT_CONCURRENCY);

      // Draining lets the queued projects through; the cap must hold there too.
      for (let round = 0; round < PROJECT_COUNT + 2; round += 1) {
        probe.drain();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(probe.peak).toBeLessThanOrEqual(COLLAB_VELA_FANOUT_CONCURRENCY);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes every dirty project once the queue drains', async () => {
    vi.useFakeTimers();
    try {
      const PROJECT_COUNT = 20;
      const published: string[] = [];
      const scheduler = new CollabPublishScheduler({
        adapter: {
          publish: async ({ projectId }) => {
            published.push(projectId);
            return { version: 1 };
          },
        },
        debounceMs: 10,
      });

      for (let index = 0; index < PROJECT_COUNT; index += 1) {
        scheduler.notifyChanged(`p${index}`);
      }
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(0);

      expect(published).toHaveLength(PROJECT_COUNT);
      expect(new Set(published).size).toBe(PROJECT_COUNT);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
