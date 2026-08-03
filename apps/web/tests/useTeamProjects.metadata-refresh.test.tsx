// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetCoalescedGet } from '../src/lib/coalesced-get';
import {
  resetTeamProjectsCache,
  resetWorkspaceContextCache,
  TEAM_PROJECTS_CHANGED_EVENT,
  useTeamProjects,
} from '../src/collab/useWorkspaceContext';
import {
  workspaceContextFixture,
  workspaceDirectoryFixture,
} from './helpers/workspace-context';

const CONTEXT = workspaceContextFixture({
  workspaceId: 'workspace-team',
  workspaceMemberId: 'member-viewer',
});

const INITIAL_PROJECTS = [
  {
    projectId: 'project-renamed',
    ownerMemberId: 'member-owner',
    name: 'Before rename',
  },
  {
    projectId: 'project-unrelated',
    ownerMemberId: 'member-other',
    name: 'Unrelated current name',
  },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('useTeamProjects targeted metadata refresh', () => {
  beforeEach(() => {
    resetCoalescedGet();
    resetWorkspaceContextCache();
    resetTeamProjectsCache();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCoalescedGet();
    resetWorkspaceContextCache();
    resetTeamProjectsCache();
  });

  it('patches only the renamed row without blanking or rolling back an unrelated row', async () => {
    const metadataRefresh = deferred<Response>();
    let catalogReads = 0;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/api/workspace/directory')) {
        return Promise.resolve(jsonResponse(workspaceDirectoryFixture([CONTEXT])));
      }
      if (url.includes('/api/workspace/context')) {
        return Promise.resolve(jsonResponse({ context: CONTEXT }));
      }
      if (url.includes('/api/workspace/projects/team')) {
        catalogReads += 1;
        if (catalogReads === 1) {
          return Promise.resolve(jsonResponse({ projects: INITIAL_PROJECTS }));
        }
        return metadataRefresh.promise;
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    }));

    const hook = renderHook(() => useTeamProjects());
    await waitFor(() => {
      expect(hook.result.current.loading).toBe(false);
      expect(hook.result.current.projects).toEqual(INITIAL_PROJECTS);
    });

    act(() => {
      window.dispatchEvent(new CustomEvent(TEAM_PROJECTS_CHANGED_EVENT, {
        detail: {
          type: 'team-projects-changed',
          projectId: 'project-renamed',
          kind: 'metadata',
        },
      }));
    });

    await waitFor(() => expect(catalogReads).toBe(2));
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.projects).toEqual(INITIAL_PROJECTS);

    metadataRefresh.resolve(jsonResponse({
      projects: [
        {
          projectId: 'project-renamed',
          ownerMemberId: 'member-owner',
          name: 'After rename',
        },
        // A broad catalog response can be older for an unrelated row. The
        // targeted metadata signal only authorizes replacing its projectId.
        {
          projectId: 'project-unrelated',
          ownerMemberId: 'member-other',
          name: 'Unrelated stale name',
        },
      ],
    }));

    await waitFor(() => {
      expect(hook.result.current.projects).toEqual([
        {
          projectId: 'project-renamed',
          ownerMemberId: 'member-owner',
          name: 'After rename',
        },
        INITIAL_PROJECTS[1],
      ]);
    });
    expect(hook.result.current.loading).toBe(false);
  });
});
