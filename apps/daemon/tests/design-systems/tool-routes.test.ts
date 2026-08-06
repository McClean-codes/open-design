import express from 'express';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { registerDesignSystemToolRoutes } from '../../src/routes/design-system-tool.js';

type JsonFetchResult = { status: number; body: Record<string, any> };

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) return resolve();
    server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
});

function fresh(): string {
  return mkdtempSync(path.join(tmpdir(), 'od-design-system-tool-routes-'));
}

function writeHybridDesignSystem(root: string, id: string): string {
  const dir = path.join(root, id);
  mkdirSync(path.join(dir, 'preview'), { recursive: true });
  writeFileSync(path.join(dir, 'DESIGN.md'), '# Test\n');
  writeFileSync(path.join(dir, 'tokens.css'), ':root { --bg: #fff; }');
  writeFileSync(path.join(dir, 'design-tokens.json'), '{"format":"od-design-tokens/v1","tokens":[]}\n');
  writeFileSync(path.join(dir, 'tailwind-v4.css'), '@import "tailwindcss";\n');
  writeFileSync(path.join(dir, 'components.html'), '<button>ok</button>');
  writeFileSync(path.join(dir, 'preview', 'colors.html'), '<h1>Colors</h1>');
  writeFileSync(path.join(dir, 'preview', 'spacing.html'), '<h1>Spacing</h1>');
  writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'od-design-system-project/v1',
    id,
    name: 'Test',
    category: 'Imported',
    source: { type: 'local', path: '/tmp/source' },
    files: {
      design: 'DESIGN.md',
      tokens: 'tokens.css',
      designTokens: 'design-tokens.json',
      tailwind: 'tailwind-v4.css',
      components: 'components.html',
    },
    preview: {
      dir: 'preview',
      pages: [{ path: 'preview/colors.html', role: 'colors', title: 'Colors' }],
    },
  }, null, 2)}\n`);
  return dir;
}

async function startRouteServer(options: {
  builtInRoot: string;
  userRoot: string;
  scopedUserRoot?: string;
  workspaceId?: string;
  workspaceMemberId?: string;
  scopeAvailable?: boolean | (() => boolean);
  activeDesignSystemId: string | null;
  runDesignSystemId?: string | null;
}): Promise<string> {
  const app = express();
  app.use(express.json());
  registerDesignSystemToolRoutes(app, {
    auth: {
      authorizeToolRequest: (_req, _res, operation) => {
        expect(['design-systems:read', 'design-systems:resolve-intent']).toContain(operation);
        return {
          token: 'token',
          runId: 'run-1',
          projectId: 'project-1',
          ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
          ...(options.workspaceMemberId
            ? { workspaceMemberId: options.workspaceMemberId }
            : {}),
          allowedEndpoints: [
            '/api/tools/design-systems/read',
            '/api/tools/design-systems/resolve-intent',
          ],
          allowedOperations: ['design-systems:read', 'design-systems:resolve-intent'],
          issuedAt: new Date(0).toISOString(),
          expiresAt: new Date(60_000).toISOString(),
        };
      },
    },
    http: {
      sendApiError: (res, status, code, message, extras = {}) => {
        res.status(status).json({ error: { code, message, ...extras } });
      },
    },
    paths: {
      DESIGN_SYSTEMS_DIR: options.builtInRoot,
      USER_DESIGN_SYSTEMS_DIR: options.userRoot,
      resolveUserDesignSystemsRoot: (grant, designSystemId) => {
        const scopeAvailable = typeof options.scopeAvailable === 'function'
          ? options.scopeAvailable()
          : options.scopeAvailable;
        if (scopeAvailable === false) {
          return {
            ok: false,
            code: 'DESIGN_SYSTEM_SCOPE_UNAVAILABLE',
            message: 'active design system is no longer available in the run workspace',
            details: {
              workspaceId: grant.workspaceId ?? '',
              designSystemId,
            },
          };
        }
        return { ok: true, root: options.scopedUserRoot ?? options.userRoot };
      },
    },
    projects: {
      getProject: () => ({
        id: 'project-1',
        designSystemId: options.activeDesignSystemId,
      }),
    },
    runs: {
      getRun: () => options.runDesignSystemId === undefined
        ? undefined
        : { designSystemId: options.runDesignSystemId },
    },
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('unexpected listen address');
  return `http://127.0.0.1:${address.port}`;
}

function copyRuntimeFixture(root: string, id: string, label: string): void {
  const target = path.join(root, id);
  cpSync(
    path.resolve(import.meta.dirname, '../fixtures/design-systems/runtime-v3'),
    target,
    { recursive: true },
  );
  const manifestPath = path.join(target, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.id = id;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const intentPath = path.join(target, 'manifests', 'intent-map.json');
  const intent = JSON.parse(readFileSync(intentPath, 'utf8')) as {
    mappings: Array<{ properties: { label: string } }>;
  };
  intent.mappings[0]!.properties.label = label;
  writeFileSync(intentPath, `${JSON.stringify(intent, null, 2)}\n`);
}

async function jsonFetch(url: string, body: Record<string, unknown>): Promise<JsonFetchResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

describe('design-system pull tool route', () => {
  it('reads manifest-allowed files from the active design system', async () => {
    const builtInRoot = fresh();
    const userRoot = fresh();
    writeHybridDesignSystem(builtInRoot, 'pull-brand');
    const baseUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      activeDesignSystemId: 'pull-brand',
    });

    const response = await jsonFetch(`${baseUrl}/api/tools/design-systems/read`, {
      path: 'preview/colors.html',
    });

    expect(response.status).toBe(200);
    expect(response.body.file).toMatchObject({
      path: 'preview/colors.html',
      encoding: 'utf8',
      content: '<h1>Colors</h1>',
    });

    const derived = await jsonFetch(`${baseUrl}/api/tools/design-systems/read`, {
      path: 'design-tokens.json',
    });

    expect(derived.status).toBe(200);
    expect(derived.body.file).toMatchObject({
      path: 'design-tokens.json',
      encoding: 'utf8',
      content: expect.stringContaining('od-design-tokens/v1'),
    });
  });

  it('resolves a canonical intent to component implementation, variant, properties, and states', async () => {
    const builtInRoot = fresh();
    const userRoot = fresh();
    cpSync(
      path.resolve(import.meta.dirname, '../fixtures/design-systems/runtime-v3'),
      path.join(builtInRoot, 'runtime-v3'),
      { recursive: true },
    );
    const baseUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      activeDesignSystemId: 'project-default',
      runDesignSystemId: 'runtime-v3',
    });

    const matched = await jsonFetch(`${baseUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'account.settings.save',
    });
    expect(matched.status, JSON.stringify(matched.body)).toBe(200);
    expect(matched.body).toMatchObject({
      designSystemId: 'runtime-v3',
      runtime: 'structured',
      resolution: {
        status: 'matched',
        action: 'reuse-components',
        matches: [{
          component: { id: 'Button', implementation: expect.stringContaining('<button') },
          variant: { id: 'primary' },
          properties: { label: 'Save changes', disabled: false },
          states: [{ id: 'hover' }, { id: 'focus' }],
        }],
      },
      lint: {
        requireMappedComponentReuse: true,
        requireDeclaredStates: true,
      },
    });

    const noMatch = await jsonFetch(`${baseUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'workspace.delete.confirm',
    });
    expect(noMatch.status).toBe(200);
    expect(noMatch.body.resolution).toMatchObject({
      status: 'confirmation-required',
      reason: 'no-match',
      action: 'request-human-confirmation',
      allowInventComponent: false,
      outputMarker: 'data-ds-fallback="no-match"',
    });

    const invalidIntent = await jsonFetch(`${baseUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'Account settings save',
    });
    expect(invalidIntent.status).toBe(400);
    expect(invalidIntent.body.error.code).toBe('INVALID_INPUT');
  });

  it('resolves a team-scoped user runtime instead of a same-id personal runtime', async () => {
    const builtInRoot = fresh();
    const userRoot = fresh();
    const teamRoot = fresh();
    copyRuntimeFixture(userRoot, 'shared-brand', 'Personal save');
    copyRuntimeFixture(teamRoot, 'shared-brand', 'Team save');
    const baseUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      scopedUserRoot: teamRoot,
      workspaceId: 'workspace-team',
      workspaceMemberId: 'member-team',
      activeDesignSystemId: 'user:shared-brand',
    });

    const response = await jsonFetch(`${baseUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'account.settings.save',
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.resolution.matches[0].properties.label).toBe('Team save');
  });

  it('fails closed when a team runtime binding is revoked during an active run', async () => {
    const builtInRoot = fresh();
    const userRoot = fresh();
    const teamRoot = fresh();
    copyRuntimeFixture(userRoot, 'shared-brand', 'Personal save');
    copyRuntimeFixture(teamRoot, 'shared-brand', 'Team save');
    let scopeAvailable = true;
    const baseUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      scopedUserRoot: teamRoot,
      workspaceId: 'workspace-team',
      workspaceMemberId: 'member-team',
      scopeAvailable: () => scopeAvailable,
      activeDesignSystemId: 'user:shared-brand',
      runDesignSystemId: 'user:shared-brand',
    });

    const beforeRevoke = await jsonFetch(`${baseUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'account.settings.save',
    });
    expect(beforeRevoke.status).toBe(200);
    expect(beforeRevoke.body.resolution.matches[0].properties.label).toBe('Team save');

    scopeAvailable = false;
    const response = await jsonFetch(`${baseUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'account.settings.save',
    });

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: 'DESIGN_SYSTEM_SCOPE_UNAVAILABLE',
      details: {
        workspaceId: 'workspace-team',
        designSystemId: 'user:shared-brand',
      },
    });
  });

  it('reports legacy and malformed runtime packages without downgrading them', async () => {
    const builtInRoot = fresh();
    const userRoot = fresh();
    writeHybridDesignSystem(builtInRoot, 'legacy-brand');
    const legacyUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      activeDesignSystemId: 'legacy-brand',
    });
    const legacy = await jsonFetch(`${legacyUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'account.settings.save',
    });
    expect(legacy.status).toBe(409);
    expect(legacy.body.error.code).toBe('DESIGN_SYSTEM_RUNTIME_UNAVAILABLE');

    await new Promise<void>((resolve, reject) => {
      server?.close((error?: Error) => (error ? reject(error) : resolve()));
    });
    server = undefined;

    cpSync(
      path.resolve(import.meta.dirname, '../fixtures/design-systems/runtime-v3'),
      path.join(builtInRoot, 'broken-runtime'),
      { recursive: true },
    );
    const brokenManifestPath = path.join(builtInRoot, 'broken-runtime', 'manifest.json');
    const brokenManifest = JSON.parse(readFileSync(brokenManifestPath, 'utf8')) as Record<string, unknown>;
    brokenManifest.id = 'broken-runtime';
    const intentPath = path.join(builtInRoot, 'broken-runtime', 'manifests', 'intent-map.json');
    const brokenIntent = JSON.parse(readFileSync(intentPath, 'utf8')) as {
      mappings: Array<{ component: string }>;
    };
    brokenIntent.mappings[0]!.component = 'MissingButton';
    writeFileSync(brokenManifestPath, `${JSON.stringify(brokenManifest, null, 2)}\n`);
    writeFileSync(intentPath, `${JSON.stringify(brokenIntent, null, 2)}\n`);

    const brokenUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      activeDesignSystemId: 'broken-runtime',
    });
    const broken = await jsonFetch(`${brokenUrl}/api/tools/design-systems/resolve-intent`, {
      intent: 'account.settings.save',
    });
    expect(broken.status).toBe(422);
    expect(broken.body.error).toMatchObject({
      code: 'DESIGN_SYSTEM_RUNTIME_INVALID',
      details: { errors: [expect.stringContaining('unknown component MissingButton')] },
    });
  });

  it('does not expose a project default when the active run explicitly disabled its design system', async () => {
    const builtInRoot = fresh();
    const userRoot = fresh();
    writeHybridDesignSystem(builtInRoot, 'project-default');
    const baseUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      activeDesignSystemId: 'project-default',
      runDesignSystemId: null,
    });

    const response = await jsonFetch(`${baseUrl}/api/tools/design-systems/read`, {
      path: 'preview/colors.html',
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('DESIGN_SYSTEM_NOT_FOUND');
  });

  it('rejects unlisted files and non-active design-system ids', async () => {
    const builtInRoot = fresh();
    const userRoot = fresh();
    writeHybridDesignSystem(builtInRoot, 'pull-brand');
    const baseUrl = await startRouteServer({
      builtInRoot,
      userRoot,
      activeDesignSystemId: 'pull-brand',
    });

    const unlisted = await jsonFetch(`${baseUrl}/api/tools/design-systems/read`, {
      path: 'preview/spacing.html',
    });
    expect(unlisted.status).toBe(404);
    expect(unlisted.body.error.code).toBe('DESIGN_SYSTEM_FILE_NOT_FOUND');

    const mismatch = await jsonFetch(`${baseUrl}/api/tools/design-systems/read`, {
      designSystemId: 'other-brand',
      path: 'preview/colors.html',
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe('DESIGN_SYSTEM_DENIED');
  });
});
