// FleetOps regression: sandboxed (Origin: null) preview asset GETs must reach
// their route handler — and the raw preview-font path must serve bytes with
// ACAO so srcdoc iframes stop silently falling back to system fonts — while
// every other auth boundary stays intact.
//
// Mirrors the api-token-guard harness: the daemon starts with OD_API_TOKEN set
// on 127.0.0.1 and every NEW socket is stamped non-loopback (172.18.0.1) so
// the API-token middleware's bearer path is exercised rather than the loopback
// shortcut. Projects/fixtures are created BEFORE the socket stamp is
// registered (loopback, no auth) and each probe opens a fresh `Connection:
// close` socket so the non-loopback stamp applies.
//
// Boundary contract under test:
//   + GET /api/projects/:id/raw/fonts/*.woff2 with Origin: null, no bearer
//     → 200 + Access-Control-Allow-Origin: * (route-level project/workspace
//     authorization still runs before bytes are served).
//   - Same request without Origin: null (plain client) → 401 + WWW-Authenticate.
//   - Same request from a real cross-origin site → 401 (auth rejects first).
//   - Same request to a workspace-bound project without workspace headers
//     → rejected (403/404), never 200.
//   - Forged preview scope → 404 (scope validation intact).
//   - Origin: null on a non-preview route → 401 (auth) — not exempted.
//   - Origin: null POST → 401 (read-only surface only).
//   - Wrong bearer on unrelated API traffic → 401.
//   - Minted preview scope asset still serves 200 + ACAO for Origin: null.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureWorkspaceProject, openDatabase } from '../src/db.js';
import { startServer } from '../src/server.js';

const PREVIOUS_TOKEN = process.env.OD_API_TOKEN;

let server: http.Server | undefined;
let shutdown: (() => Promise<void> | void) | undefined;
let baseUrl = '';
let staticStamped = false;
let projectsToClean: string[] = [];

function makeConnectionsAppearNonLoopback(target: http.Server): void {
  target.prependListener('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', {
      configurable: true,
      value: '172.18.0.1',
    });
  });
}

function requestWithHeaders(
  url: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ body: string; status: number | undefined; headers: http.IncomingHttpHeaders }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method,
        headers: { ...headers, connection: 'close' },
        // A fresh socket per probe so the non-loopback stamp (registered via
        // the server's 'connection' listener) applies to every request.
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            body: Buffer.concat(chunks).toString('utf8'),
            status: res.statusCode,
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  process.env.OD_API_TOKEN = 'secret-test-token';
  const started = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
  projectsToClean = [];
});

afterEach(async () => {
  for (const id of projectsToClean.splice(0)) {
    await fetch(`${baseUrl}/api/projects/${id}`, { method: 'DELETE' }).catch(() => {});
  }
  if (shutdown) await Promise.resolve(shutdown());
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  shutdown = undefined;
  if (PREVIOUS_TOKEN === undefined) delete process.env.OD_API_TOKEN;
  else process.env.OD_API_TOKEN = PREVIOUS_TOKEN;
  if (staticStamped) {
    staticStamped = false;
  }
});

async function createProject(metadata: Record<string, unknown> = {}): Promise<string> {
  const id = `preview-sandbox-asset-${randomUUID()}`;
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, name: 'Sandbox preview asset project', metadata }),
  });
  expect(response.ok).toBe(true);
  projectsToClean.push(id);
  return id;
}

async function writeProjectFile(projectId: string, name: string, content: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, content }),
  });
  expect(response.ok).toBe(true);
}

function stampNonLoopbackForProbes(): void {
  if (!server) throw new Error('server not started');
  if (!staticStamped) {
    makeConnectionsAppearNonLoopback(server);
    staticStamped = true;
  }
}

function workspaceHeaders(workspaceId: string, workspaceMemberId: string): Record<string, string> {
  return {
    'x-od-workspace-id': workspaceId,
    'x-od-workspace-member-id': workspaceMemberId,
    'x-od-workspace-type': 'personal',
    'x-od-workspace-role': 'member',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-can-share-projects': 'true',
    'x-od-workspace-can-write-synced-files': 'true',
  };
}

function bindPersonalProject(
  projectId: string,
  workspaceId: string,
  workspaceMemberId: string,
): void {
  const dataDir = process.env.OD_DATA_DIR;
  if (!dataDir) throw new Error('OD_DATA_DIR is required by the daemon test harness');
  const db = openDatabase(process.cwd(), { dataDir });
  ensureWorkspaceProject(db, {
    projectId,
    workspaceId,
    visibility: 'personal',
    resourceState: 'active',
    createdByWorkspaceMemberId: workspaceMemberId,
    updatedByWorkspaceMemberId: workspaceMemberId,
    resourceHubResourceId: null,
    cloudTombstonedAt: null,
    syncState: 'local_only',
  });
}

describe('sandboxed preview asset origin (raw preview fonts with Origin: null)', () => {
  it('serves the opaque-origin raw preview font with ACAO once auth accepts the sandbox-safe route', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(
      projectId,
      'index.html',
      '<!doctype html><style>@font-face{font-family:X;src:url(fonts/x.woff2)}</style>',
    );
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');

    stampNonLoopbackForProbes();

    const probe = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      { origin: 'null', host: '172.18.0.1:9999' },
    );

    expect(probe.status).toBe(200);
    expect(probe.headers['access-control-allow-origin']).toBe('*');
    expect(probe.body).toContain('FAKE-FONT-BYTES');
  });

  it('keeps the minted preview-scope asset path working for opaque origins', async () => {
    const projectId = await createProject({ entryFile: 'pages/index.html' });
    await writeProjectFile(projectId, 'pages/index.html', '<!doctype html><title>Preview</title>');
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');

    stampNonLoopbackForProbes();

    const mojito = await fetch(`${baseUrl}/api/projects/${projectId}/preview-url?file=${encodeURIComponent('pages/index.html')}`);
    expect(mojito.ok).toBe(true);
    const body = await mojito.json() as { url: string };
    expect(body.url).toContain(`/api/projects/${projectId}/preview/`);
    const scope = body.url.match(/\/preview\/([^/]+)\//u)?.[1];
    expect(scope).toBeTruthy();

    const scopedProbe = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/preview/${scope}/fonts/x.woff2`,
      { origin: 'null', host: '172.18.0.1:9999' },
    );
    expect(scopedProbe.status).toBe(200);
    expect(scopedProbe.headers['access-control-allow-origin']).toBe('*');
    expect(scopedProbe.body).toContain('FAKE-FONT-BYTES');
  });

  it('still rejects a plain no-Origin client on the raw font path with a challenge', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');

    stampNonLoopbackForProbes();

    const probe = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      { host: '172.18.0.1:9999' },
    );

    expect(probe.status).toBe(401);
    expect(probe.headers['www-authenticate']).toBe('Basic realm="Open Design", charset="UTF-8"');
    expect(probe.body).toContain('API_TOKEN_REQUIRED');
  });

  it('still rejects a real cross-origin site on the raw font path', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');

    stampNonLoopbackForProbes();

    const probe = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      { origin: 'https://evil.example', host: '172.18.0.1:9999' },
    );

    expect(probe.status).toBe(401);
  });

  it('still rejects a wrong bearer even on the opaque-origin raw font path', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');

    stampNonLoopbackForProbes();

    const wrongBearer = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      {
        origin: 'null',
        host: '172.18.0.1:9999',
        authorization: 'Bearer wrong-token',
      },
    );
    expect(wrongBearer.status).toBe(401);

    const rightBearer = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      {
        origin: 'null',
        host: '172.18.0.1:9999',
        authorization: 'Bearer secret-test-token',
      },
    );
    expect(rightBearer.status).toBe(200);
    expect(rightBearer.body).toContain('FAKE-FONT-BYTES');
  });

  it('still rejects a forged preview scope for opaque-origin asset GETs', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');

    stampNonLoopbackForProbes();

    const forged = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/preview/forged-specious-scope-0000000001/fonts/x.woff2`,
      { origin: 'null', host: '172.18.0.1:9999' },
    );

    expect(forged.status).toBe(404);
    expect(forged.body).toContain('PREVIEW_SCOPE_NOT_FOUND');
  });

  it('still rejects opaque-origin GETs on non-preview API routes', async () => {
    stampNonLoopbackForProbes();

    const probe = await requestWithHeaders(
      `${baseUrl}/api/projects`,
      { origin: 'null', host: '172.18.0.1:9999' },
    );

    expect(probe.status).toBe(401);
  });

  it('still rejects opaque-origin mutating requests on the raw surface', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');

    stampNonLoopbackForProbes();

    const probe = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      { origin: 'null', host: '172.18.0.1:9999', 'content-type': 'application/json' },
      'POST',
    );

    expect(probe.status).toBe(401);
  });

  it('still requires a matching bearer for unrelated API traffic', async () => {
    stampNonLoopbackForProbes();

    const wrongBearer = await requestWithHeaders(
      `${baseUrl}/api/plugins`,
      { authorization: 'Bearer wrong-token', host: '172.18.0.1:9999' },
    );
    expect(wrongBearer.status).toBe(401);

    const rightBearer = await requestWithHeaders(
      `${baseUrl}/api/plugins`,
      { authorization: 'Bearer secret-test-token', host: '172.18.0.1:9999' },
    );
    expect(rightBearer.status).toBe(200);
  });

  it('keeps project/workspace containment: workspace-bound project raw reads stay rejected for header-less srcdoc iframes', async () => {
    const projectId = await createProject({ entryFile: 'index.html' });
    await writeProjectFile(projectId, 'fonts/x.woff2', 'FAKE-FONT-BYTES');
    bindPersonalProject(projectId, 'ws-sandbox-1', 'member-sandbox-1');

    stampNonLoopbackForProbes();

    const probe = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      { origin: 'null', host: '172.18.0.1:9999' },
    );

    // A sandboxed iframe cannot attach workspace headers, so the route-level
    // project authority must refuse before any bytes are served.
    expect(probe.status).toBeGreaterThanOrEqual(400);
    expect(probe.status).not.toBe(200);
    expect(probe.body).not.toContain('FAKE-FONT-BYTES');

    // The same file remains readable with the bound workspace context + bearer.
    const authorized = await requestWithHeaders(
      `${baseUrl}/api/projects/${projectId}/raw/fonts/x.woff2`,
      {
        origin: 'null',
        host: '172.18.0.1:9999',
        authorization: 'Bearer secret-test-token',
        ...workspaceHeaders('ws-sandbox-1', 'member-sandbox-1'),
      },
    );
    expect(authorized.status).toBe(200);
    expect(authorized.body).toContain('FAKE-FONT-BYTES');
  });
});