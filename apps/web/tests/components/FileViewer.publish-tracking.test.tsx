// @vitest-environment jsdom

// The Share tab's "Publish this file for everyone" flow reports three
// analytics points: the publish button click (`ui_click` element
// `publish_file`), the settled outcome (`artifact_publish_result` with
// action/result/error_code), and the post-publish copy-link click (`ui_click`
// element `copy_publish_link`). These are the numerator inputs for the 产物导出率
// metric once publish success joins it, so a silent regression here would make
// the metric under-count real sharing again.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { FileViewer } from '../../src/components/FileViewer';
import {
  CollabProvider,
  type CollabContextValue,
} from '../../src/collab/collab-context';
import type { ProjectFile } from '../../src/types';

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
  newRequestId: vi.fn(() => 'request-publish-1'),
}));

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analytics.track,
    newRequestId: analytics.newRequestId,
  }),
}));

function teamWorkspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
  };
}

function htmlFile(): ProjectFile {
  return {
    name: 'index.html',
    path: 'index.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'index.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

function renderProjectFileViewer(
  context: WorkspaceCollabContext,
  props: ComponentProps<typeof FileViewer>,
) {
  const collab: CollabContextValue = {
    workspaceContext: context,
    workspaceContextLoading: false,
    enabled: true,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: false,
    writerAuthority: 'allowed',
    isOwner: true,
    isEffectiveOwner: true,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: () => {},
    requestPublish: () => {},
    refreshPresence: () => {},
    checkStatusNow: () => {},
  };
  return render(
    <CollabProvider value={collab}>
      <FileViewer {...props} />
    </CollabProvider>,
  );
}

function stubFetch(
  options: { publishStatus?: number; publishBody?: unknown; unpublishStatus?: number } = {},
) {
  const { publishStatus = 200, publishBody, unpublishStatus = 200 } = options;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/workspace/context')) {
      return new Response(JSON.stringify({ context: teamWorkspaceContext() }), { status: 200 });
    }
    if (url.includes('publish-public')) {
      if (init?.method === 'POST') {
        const body =
          publishBody ??
          (publishStatus === 200
            ? { url: 'https://open-design.ai/p/slug-1', slug: 'slug-1', fileName: 'index.html' }
            : { error: { message: 'WORKSPACE_IDENTITY_REQUIRED' } });
        return new Response(JSON.stringify(body), { status: publishStatus });
      }
      if (init?.method === 'DELETE') {
        const body =
          unpublishStatus === 200
            ? { ok: true, slug: 'slug-1', fileName: 'index.html' }
            : { error: { message: 'WORKSPACE_IDENTITY_REQUIRED' } };
        return new Response(JSON.stringify(body), { status: unpublishStatus });
      }
      return new Response(JSON.stringify({ publication: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function trackedEvents(name: string): Record<string, unknown>[] {
  return analytics.track.mock.calls
    .filter(([event]) => event === name)
    .map(([, props]) => props as Record<string, unknown>);
}

function reactComponentFile(): ProjectFile {
  return {
    name: 'App.jsx',
    path: 'App.jsx',
    type: 'file',
    size: 512,
    mtime: 1710000000,
    kind: 'code',
    mime: 'text/javascript',
    artifactManifest: {
      version: 1,
      kind: 'react-component',
      title: 'App',
      entry: 'App.jsx',
      renderer: 'react-component',
      exports: ['jsx'],
    },
  };
}

async function openPublishPanel() {
  renderProjectFileViewer(teamWorkspaceContext(), {
    projectId: 'project-pub',
    projectKind: 'prototype',
    file: htmlFile(),
    liveHtml: '<html><body><h1>Hello</h1></body></html>',
  });
  const shareButton = await screen.findByRole('button', { name: /^share$/i });
  fireEvent.click(shareButton);
  return await screen.findByRole('button', { name: /publish file/i });
}

// Same flow through the ReactComponentViewer copy of the publish card, which
// is hand-duplicated from HtmlViewer and can regress independently.
async function openReactComponentPublishPanel() {
  renderProjectFileViewer(teamWorkspaceContext(), {
    projectId: 'project-pub',
    projectKind: 'prototype',
    file: reactComponentFile(),
  });
  const shareButton = await screen.findByRole('button', { name: /^share$/i });
  fireEvent.click(shareButton);
  return await screen.findByRole('button', { name: /publish file/i });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  analytics.track.mockReset();
  analytics.newRequestId.mockClear();
});

describe('publish flow analytics', () => {
  it('reports the publish click, the success result, and the copy-link click', async () => {
    stubFetch();
    const publishButton = await openPublishPanel();
    fireEvent.click(publishButton);

    expect(trackedEvents('ui_click')).toContainEqual(
      expect.objectContaining({
        area: 'share_option_popover',
        element: 'publish_file',
        project_id: 'project-pub',
      }),
    );
    await waitFor(() => {
      expect(trackedEvents('artifact_publish_result')).toContainEqual(
        expect.objectContaining({
          action: 'publish',
          result: 'success',
          publish_duration_ms: expect.any(Number),
        }),
      );
    });

    const copyButton = await screen.findByRole('button', { name: /copy share link/i });
    fireEvent.click(copyButton);
    expect(trackedEvents('ui_click')).toContainEqual(
      expect.objectContaining({
        area: 'share_option_popover',
        element: 'copy_publish_link',
      }),
    );
  });

  it('reports a failed publish with the workspace-identity error code', async () => {
    stubFetch({ publishStatus: 403 });
    const publishButton = await openPublishPanel();
    fireEvent.click(publishButton);

    await waitFor(() => {
      expect(trackedEvents('artifact_publish_result')).toContainEqual(
        expect.objectContaining({
          action: 'publish',
          result: 'failed',
          error_code: 'workspace_identity_required',
        }),
      );
    });
    // A failed publish must not report a success or render the copy-link state.
    expect(
      trackedEvents('artifact_publish_result').some((p) => p.result === 'success'),
    ).toBe(false);
  });

  it('reports a successful unpublish as action unpublish', async () => {
    stubFetch();
    const publishButton = await openPublishPanel();
    fireEvent.click(publishButton);

    const unpublishButton = await screen.findByRole('button', { name: /unpublish file/i });
    fireEvent.click(unpublishButton);
    await waitFor(() => {
      expect(trackedEvents('artifact_publish_result')).toContainEqual(
        expect.objectContaining({
          action: 'unpublish',
          result: 'success',
          publish_duration_ms: expect.any(Number),
        }),
      );
    });
  });

  it('reports a failed unpublish with the workspace-identity error code', async () => {
    stubFetch({ unpublishStatus: 403 });
    const publishButton = await openPublishPanel();
    fireEvent.click(publishButton);

    const unpublishButton = await screen.findByRole('button', { name: /unpublish file/i });
    fireEvent.click(unpublishButton);
    await waitFor(() => {
      expect(trackedEvents('artifact_publish_result')).toContainEqual(
        expect.objectContaining({
          action: 'unpublish',
          result: 'failed',
          error_code: 'workspace_identity_required',
        }),
      );
    });
    // The failed unpublish must not clear the published state's success record.
    expect(
      trackedEvents('artifact_publish_result').filter((p) => p.action === 'unpublish' && p.result === 'success'),
    ).toEqual([]);
  });

  it('reports project_kind null from the ReactComponentViewer copy of the flow', async () => {
    stubFetch();
    const publishButton = await openReactComponentPublishPanel();
    fireEvent.click(publishButton);

    expect(trackedEvents('ui_click')).toContainEqual(
      expect.objectContaining({
        area: 'share_option_popover',
        element: 'publish_file',
        project_kind: null,
      }),
    );
    await waitFor(() => {
      expect(trackedEvents('artifact_publish_result')).toContainEqual(
        expect.objectContaining({
          action: 'publish',
          result: 'success',
          project_kind: null,
        }),
      );
    });
  });
});
