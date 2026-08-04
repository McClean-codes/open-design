// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { StrictMode, type ReactNode } from 'react';
import { workspaceContextFixture } from './helpers/workspace-context';
import { evictCoalescedGet } from '../src/lib/coalesced-get';
import { workspaceIdentityCacheKey } from '../src/collab/workspace-identity';

const harness = vi.hoisted(() => ({
  context: null as WorkspaceCollabContext | null,
}));

vi.mock('../src/collab/useWorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    context: harness.context,
    identityChangePending: false,
  }),
}));

vi.mock('../src/collab/workspace-events', () => ({
  useWorkspaceInvalidation: () => ({ connected: false }),
}));

import { useTeamMembers } from '../src/collab/useTeamMembers';

const TEAM_CONTEXT = workspaceContextFixture({
  workspaceId: 'workspace-shared-scheduler',
  workspaceMemberId: 'member-viewer',
});

describe('useTeamMembers shared scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.context = TEAM_CONTEXT;
    evictCoalescedGet(
      `workspace-members:${workspaceIdentityCacheKey(TEAM_CONTEXT)}`,
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('uses one initial read and one poll loop for two consumers of one identity', async () => {
    const membersReads: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (!String(input).includes('/api/workspace/members')) {
          throw new Error(`unexpected fetch: ${String(input)}`);
        }
        membersReads.push(Date.now());
        return new Response(JSON.stringify({ members: [] }), { status: 200 });
      }),
    );

    const first = renderHook(() => useTeamMembers());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(membersReads).toHaveLength(1);

    // Mount the second consumer outside coalescedGet's 1s cache window. A
    // per-hook scheduler performs another mount read and creates a poll offset
    // from the first one; an identity store reuses the settled snapshot.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const second = renderHook(() => useTeamMembers());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(membersReads).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(13_000);
    });
    expect(membersReads).toHaveLength(2);

    // The second hook's former 15s interval would fire two seconds later.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(membersReads).toHaveLength(2);

    first.unmount();
    second.unmount();
  });

  it('keeps the pending first roster through StrictMode effect replay', async () => {
    let resolveMembers!: (response: Response) => void;
    const membersReads: number[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL): Promise<Response> => {
        if (!String(input).includes('/api/workspace/members')) {
          throw new Error(`unexpected fetch: ${String(input)}`);
        }
        membersReads.push(Date.now());
        return new Promise<Response>((resolve) => {
          resolveMembers = resolve;
        });
      }),
    );
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const hook = renderHook(() => useTeamMembers(), { wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(membersReads).toHaveLength(1);

    await act(async () => {
      resolveMembers(
        new Response(
          JSON.stringify({
            members: [
              {
                memberId: 'member-peer',
                displayName: 'Visible peer',
                role: 'member',
              },
            ],
          }),
          { status: 200 },
        ),
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(hook.result.current.members).toEqual([
      {
        memberId: 'member-peer',
        displayName: 'Visible peer',
        role: 'member',
      },
    ]);
    expect(membersReads).toHaveLength(1);
    hook.unmount();
  });
});
