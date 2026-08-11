import { describe, expect, it, vi } from 'vitest';

import {
  createWorkspaceAuthorityHealthCoordinator,
  resolveWorkspaceAuthorityCacheMode,
} from '../../src/collab/workspace-authority-health.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('workspace authority health coordinator', () => {
  it('defaults unknown and absent modes to the legacy kill switch', () => {
    expect(resolveWorkspaceAuthorityCacheMode(undefined)).toBe('legacy');
    expect(resolveWorkspaceAuthorityCacheMode('unexpected')).toBe('legacy');
    expect(resolveWorkspaceAuthorityCacheMode(' OBSERVE ')).toBe('observe');
    expect(resolveWorkspaceAuthorityCacheMode('adaptive')).toBe('adaptive');
  });

  it('does not suppress a poll in legacy or observe mode', async () => {
    for (const mode of ['legacy', 'observe'] as const) {
      const catchUp = vi.fn(async () => undefined);
      const states: boolean[] = [];
      const coordinator = createWorkspaceAuthorityHealthCoordinator({
        mode,
        catchUp,
        setDirectoryPollingHealthy: (_workspaceId, healthy) => states.push(healthy),
        setBillingPollingHealthy: () => undefined,
      });

      await coordinator.update({ workspaceId: 'w1', healthy: true });
      expect(catchUp).not.toHaveBeenCalled();
      expect(states).toEqual([false]);
    }
  });

  it('enables adaptive polling only after catch-up completes', async () => {
    const gate = deferred();
    const states: boolean[] = [];
    const onDecision = vi.fn();
    const coordinator = createWorkspaceAuthorityHealthCoordinator({
      mode: 'adaptive',
      catchUp: () => gate.promise,
      setDirectoryPollingHealthy: (_workspaceId, healthy) => states.push(healthy),
      setBillingPollingHealthy: () => undefined,
      onDecision,
    });

    const update = coordinator.update({ workspaceId: 'w1', healthy: true });
    expect(states).toEqual([false]);
    gate.resolve();
    await update;
    expect(states).toEqual([false, true]);
    expect(onDecision).toHaveBeenCalledWith({
      source: 'sse',
      reason: 'healthy',
      outcome: 'allow',
    });
  });

  it('cannot re-enable adaptive polling from a catch-up that lost its health generation', async () => {
    const gate = deferred();
    const directoryStates: boolean[] = [];
    const billingStates: boolean[] = [];
    const coordinator = createWorkspaceAuthorityHealthCoordinator({
      mode: 'adaptive',
      catchUp: () => gate.promise,
      setDirectoryPollingHealthy: (_workspaceId, healthy) =>
        directoryStates.push(healthy),
      setBillingPollingHealthy: (_workspaceId, healthy) =>
        billingStates.push(healthy),
    });

    const connecting = coordinator.update({ workspaceId: 'w1', healthy: true });
    await coordinator.update({ workspaceId: 'w1', healthy: false });
    gate.resolve();
    await connecting;

    expect(directoryStates).toEqual([false, false]);
    expect(billingStates).toEqual([false, false]);
  });
});
