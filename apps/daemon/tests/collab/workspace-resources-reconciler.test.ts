import { describe, expect, it, vi } from 'vitest';

import {
  planWorkspaceResourceReconciliation,
  reconcileWorkspaceResourcesWithRemote,
  type LocalTeamResourceBinding,
} from '../../src/collab/workspace-resources-reconciler.js';

const WORKSPACE_ID = 'team-1';

describe('planWorkspaceResourceReconciliation (pure)', () => {
  it('retires a local active-team row the remote listing no longer confirms', () => {
    const localActiveTeamRows: LocalTeamResourceBinding[] = [
      { resourceId: 'skill-gone', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
    ];
    const actions = planWorkspaceResourceReconciliation({
      workspaceId: WORKSPACE_ID,
      remoteResources: [],
      localActiveTeamRows,
    });
    expect(actions).toEqual([
      { kind: 'retire', resourceId: 'skill-gone', workspaceId: WORKSPACE_ID },
    ]);
  });

  it('does nothing when the remote listing still confirms the local row', () => {
    const localActiveTeamRows: LocalTeamResourceBinding[] = [
      { resourceId: 'skill-still-shared', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
    ];
    const actions = planWorkspaceResourceReconciliation({
      workspaceId: WORKSPACE_ID,
      remoteResources: [{ resourceId: 'skill-still-shared' }],
      localActiveTeamRows,
    });
    expect(actions).toEqual([]);
  });

  it('ignores a row bound to a DIFFERENT workspace than the one being reconciled', () => {
    const localActiveTeamRows: LocalTeamResourceBinding[] = [
      { resourceId: 'skill-other-ws', workspaceId: 'team-2', visibility: 'team', resourceState: 'active' },
    ];
    const actions = planWorkspaceResourceReconciliation({
      workspaceId: WORKSPACE_ID,
      remoteResources: [],
      localActiveTeamRows,
    });
    expect(actions).toEqual([]);
  });

  it('retires multiple stale rows in one pass and leaves confirmed ones alone', () => {
    const localActiveTeamRows: LocalTeamResourceBinding[] = [
      { resourceId: 'still-shared', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
      { resourceId: 'gone-1', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
      { resourceId: 'gone-2', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
    ];
    const actions = planWorkspaceResourceReconciliation({
      workspaceId: WORKSPACE_ID,
      remoteResources: [{ resourceId: 'still-shared' }],
      localActiveTeamRows,
    });
    expect(actions).toEqual([
      { kind: 'retire', resourceId: 'gone-1', workspaceId: WORKSPACE_ID },
      { kind: 'retire', resourceId: 'gone-2', workspaceId: WORKSPACE_ID },
    ]);
  });
});

describe('reconcileWorkspaceResourcesWithRemote (orchestrator)', () => {
  function baseDeps(overrides: Partial<Parameters<typeof reconcileWorkspaceResourcesWithRemote>[0]> = {}) {
    return {
      getWorkspaceIdentity: async () => ({ workspaceId: WORKSPACE_ID }),
      listRemoteTeamResources: async () => [],
      listLocalActiveTeamRows: () => [],
      applyRetire: vi.fn(),
      ...overrides,
    };
  }

  it('is a no-op off-team (getWorkspaceIdentity resolves null)', async () => {
    const listRemoteTeamResources = vi.fn(async () => []);
    const applyRetire = vi.fn();
    const result = await reconcileWorkspaceResourcesWithRemote(
      baseDeps({ getWorkspaceIdentity: async () => null, listRemoteTeamResources, applyRetire }),
    );
    expect(result).toEqual({ retired: 0 });
    expect(listRemoteTeamResources).not.toHaveBeenCalled();
    expect(applyRetire).not.toHaveBeenCalled();
  });

  it('never retires on a failed remote read (best-effort: missing data is not empty data)', async () => {
    const applyRetire = vi.fn();
    const onError = vi.fn();
    const result = await reconcileWorkspaceResourcesWithRemote(
      baseDeps({
        listLocalActiveTeamRows: () => [
          { resourceId: 'r1', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
        ],
        listRemoteTeamResources: async () => {
          throw new Error('vela unreachable');
        },
        applyRetire,
        onError,
      }),
    );
    expect(result).toEqual({ retired: 0 });
    expect(applyRetire).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never retires on a failed identity read either', async () => {
    const applyRetire = vi.fn();
    const onError = vi.fn();
    const result = await reconcileWorkspaceResourcesWithRemote(
      baseDeps({
        getWorkspaceIdentity: async () => {
          throw new Error('workspace context read failed');
        },
        applyRetire,
        onError,
      }),
    );
    expect(result).toEqual({ retired: 0 });
    expect(applyRetire).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('applies retire actions through the injected writer and reports the count', async () => {
    const applyRetire = vi.fn();
    const result = await reconcileWorkspaceResourcesWithRemote(
      baseDeps({
        listLocalActiveTeamRows: () => [
          { resourceId: 'gone', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
        ],
        listRemoteTeamResources: async () => [],
        applyRetire,
      }),
    );
    expect(result).toEqual({ retired: 1 });
    expect(applyRetire).toHaveBeenCalledWith(WORKSPACE_ID, 'gone');
  });

  it('reports one writer failure through onError without aborting the rest of the pass', async () => {
    const onError = vi.fn();
    const applied: string[] = [];
    const result = await reconcileWorkspaceResourcesWithRemote(
      baseDeps({
        listLocalActiveTeamRows: () => [
          { resourceId: 'a', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
          { resourceId: 'b', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'active' },
        ],
        listRemoteTeamResources: async () => [],
        applyRetire: (workspaceId: string, resourceId: string) => {
          if (resourceId === 'a') throw new Error('sqlite busy');
          applied.push(resourceId);
        },
        onError,
      }),
    );
    expect(result).toEqual({ retired: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(applied).toEqual(['b']);
  });

  it('does not retire a row already resourceState:"deleted" (the caller is expected to prefilter, but a stray row must stay a no-op if it slips through)', async () => {
    // Belt-and-suspenders: even if a caller's `listLocalActiveTeamRows` bug
    // let a `resourceState: 'deleted'` row through, the planner only acts on
    // ABSENCE from the remote listing, so passing an already-retired row that
    // the remote ALSO no longer lists would retire it again (idempotent —
    // `applyRetire` writing the same 'deleted' state twice is harmless). This
    // pins that idempotency rather than asserting a prefilter this module
    // does not own.
    const applyRetire = vi.fn();
    const result = await reconcileWorkspaceResourcesWithRemote(
      baseDeps({
        listLocalActiveTeamRows: () => [
          { resourceId: 'already-retired', workspaceId: WORKSPACE_ID, visibility: 'team', resourceState: 'deleted' },
        ],
        listRemoteTeamResources: async () => [],
        applyRetire,
      }),
    );
    expect(result).toEqual({ retired: 1 });
    expect(applyRetire).toHaveBeenCalledWith(WORKSPACE_ID, 'already-retired');
  });
});
