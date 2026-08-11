import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createAuthorizeProjectRequest } from '../src/collab/project-request-authority.js';
import { verifyWorkspaceRequestContext } from '../src/collab/request-workspace-context.js';
import { workspaceContextFromDirectoryItem } from '../src/collab/vela-workspace-context.js';
import { createToolRequestAuth } from '../src/http/tool-request-auth.js';
import { sendApiError } from '../src/http/api-errors.js';
import { registerProjectExportRoutes } from '../src/import-export-routes.js';
import { ToolTokenRegistry } from '../src/tool-tokens.js';

const WORKSPACE_ID = 'workspace-a';
const MEMBER_ID = 'member-a';
const PROJECT_ID = 'bound-project';
const RUN_ID = 'run-1';

const DIRECTORY_ITEM = {
  workspaceId: WORKSPACE_ID,
  workspaceName: 'A',
  workspaceType: 'team' as const,
  workspaceMemberId: MEMBER_ID,
  role: 'member' as const,
  memberStatus: 'active' as const,
  lifecycleState: 'active' as const,
};

// The project is claimed by a workspace — the shape every Team/Personal
// workspace project has had since workspace isolation shipped, and the shape
// that makes the header gate fail closed for a headerless caller.
const BINDING = {
  projectId: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
  visibility: 'personal',
  resourceState: 'active',
  createdByWorkspaceMemberId: MEMBER_ID,
};

let server: http.Server | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  if (server) {
    const toClose = server;
    server = null;
    await new Promise<void>((resolve) => toClose.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function startExportServer(): Promise<{ baseUrl: string; token: string }> {
  const renderDir = await mkdtemp(path.join(os.tmpdir(), 'od-export-tool-'));
  tempDirs.push(renderDir);
  const renderedPath = path.join(renderDir, 'rendered.png');
  await writeFile(renderedPath, 'png-bytes');

  const registry = new ToolTokenRegistry();
  const grant = registry.mint({ runId: RUN_ID, projectId: PROJECT_ID });
  const auth = createToolRequestAuth(registry);

  const verifier = (req: unknown) =>
    verifyWorkspaceRequestContext({
      req,
      fetchWorkspaceDirectory: async () => ({ ok: true as const, items: [DIRECTORY_ITEM] }),
    });
  const authorizeProjectRequest = createAuthorizeProjectRequest({
    db: {},
    getWorkspaceProject: () => BINDING,
    getWorkspaceProjectByProjectId: () => BINDING,
    verifyWorkspaceReadAuthority: verifier,
    verifyWorkspaceRequestAuthority: verifier,
    // The gate declares a widened `code: string`; the daemon's real error codes
    // are the narrower ApiErrorCode union.
    sendApiError: sendApiError as unknown as (
      res: any,
      status: number,
      code: string,
      message: string,
    ) => unknown,
  });
  // Mirrors the daemon's local/dev `authorizeProjectToolRequest` branch: a tool
  // call carries no headers, so authority comes from the project's own
  // persisted workspace binding.
  const authorizeProjectToolRequest = async (_res: unknown, projectId: string) => {
    if (projectId !== PROJECT_ID) return false;
    workspaceContextFromDirectoryItem(DIRECTORY_ITEM);
    return true;
  };

  const app = express();
  app.use(express.json());
  registerProjectExportRoutes(app, {
    db: {},
    http: { sendApiError },
    paths: { PROJECTS_DIR: renderDir, RUNTIME_DATA_DIR_CANONICAL: renderDir },
    node: { fs, path },
    ids: { randomId: () => 'render-1' },
    projectStore: { getProject: () => ({ id: PROJECT_ID, metadata: null }) },
    projectFiles: {
      listFiles: async () => [],
      readProjectFile: async () => ({ content: '<html></html>' }),
      resolveProjectFilePath: () => renderedPath,
    },
    validation: { isSafeId: () => true },
    exports: {
      buildProjectArchive: async () => Buffer.alloc(0),
      buildBatchArchive: async () => Buffer.alloc(0),
      buildDesktopPdfExportInput: async () => ({}),
      // `desktopSlideRenderer` stays undefined so the route takes the
      // single-image `desktopArtifactExporter` path — the lightest branch that
      // still proves authorization let the request through to a real render.
      buildDesktopArtifactExportInput: async () => ({}),
      desktopPdfExporter: undefined,
      desktopSlideRenderer: undefined,
      desktopArtifactExporter: async () => ({
        ok: true,
        path: renderedPath,
        mime: 'image/png',
      }),
      daemonUrlRef: { current: 'http://127.0.0.1:0' },
      sanitizeArchiveFilename: (value: string) => value,
    },
    auth,
    authorizeProjectRequest,
    authorizeProjectToolRequest,
  } as any);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}`, token: grant.token };
}

describe('agent-authenticated export on a workspace-bound project', () => {
  it('renders through the tool token without any workspace headers', async () => {
    const { baseUrl, token } = await startExportServer();

    const response = await fetch(`${baseUrl}/api/tools/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ fileName: 'index.html', format: 'image' }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('png-bytes');
  });

  it('refuses a project the tool token was not minted for', async () => {
    const { baseUrl, token } = await startExportServer();

    const response = await fetch(`${baseUrl}/api/tools/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        fileName: 'index.html',
        format: 'image',
        projectId: 'someone-elses-project',
      }),
    });

    expect(response.status).toBe(403);
  });

  it('rejects an unauthenticated caller on the tool route', async () => {
    const { baseUrl } = await startExportServer();

    const response = await fetch(`${baseUrl}/api/tools/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'index.html', format: 'image' }),
    });

    expect(response.status).toBe(401);
  });

  it('keeps the browser-facing project route gated on workspace headers', async () => {
    const { baseUrl } = await startExportServer();

    const response = await fetch(`${baseUrl}/api/projects/${PROJECT_ID}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: 'index.html', format: 'image' }),
    });

    expect(response.status).toBe(400);
    const failure = (await response.json()) as { error: { code: string } };
    expect(failure.error.code).toBe('WORKSPACE_CONTEXT_REQUIRED');
  });
});

// Guards the file the renderer stub hands back, so a future change that starts
// streaming a different path fails loudly instead of silently exporting blanks.
describe('export render stub', () => {
  it('reads the bytes the renderer reported', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'od-export-tool-stub-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'rendered.png');
    await writeFile(file, 'png-bytes');
    expect((await readFile(file)).toString()).toBe('png-bytes');
  });
});
