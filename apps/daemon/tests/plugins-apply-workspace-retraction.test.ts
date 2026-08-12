import express from 'express';
import type { ApplyResult, InstalledPluginRecord } from '@open-design/contracts';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerPluginRoutes } from '../src/routes/plugins/index.js';
import { applyPlugin as applyPluginCore } from '../src/plugins/apply.js';

const servers: Array<ReturnType<express.Express['listen']>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })),
  );
});

describe('Team plugin apply retraction gate', () => {
  it('does not apply a Team plugin retired while registry loading is pending', async () => {
    const app = express();
    app.use(express.json());
    let bindingLive = true;
    let finishRegistryLoad!: (value: Record<string, never>) => void;
    const registryGate = new Promise<Record<string, never>>((resolve) => {
      finishRegistryLoad = resolve;
    });
    let registryLoadStarted!: () => void;
    const registryStarted = new Promise<void>((resolve) => {
      registryLoadStarted = resolve;
    });
    const applyPlugin = vi.fn(() => ({
      result: { capabilitiesGranted: [], appliedPlugin: { capabilitiesGranted: [] } },
      warnings: [],
    }));
    const middleware: express.RequestHandler = (_req, _res, next) => next();

    registerPluginRoutes(app, {
      db: {
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
        transaction: (run: () => unknown) => () => run(),
      },
      paths: { PROJECTS_DIR: '', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
      ids: { randomId: () => 'unused' },
      projectStore: {},
      conversations: {},
      verifyWorkspaceRequestAuthority: async () => ({
        ok: true,
        context: { workspaceId: 'ws-team' },
      }),
      workspaceResources: {
        getWorkspaceResource: () => null,
        getWorkspaceResourceByResourceId: () => null,
        workspaceTeamPluginBindingAllowsRead: () => bindingLive,
      },
      plugins: {
        getInstalledPlugin: () => null,
        getWorkspacePlugin: async () => ({
          id: 'team-plugin',
          source: 'team:plugin:ws-team:team-plugin',
        }),
        listInstalledPlugins: () => [],
        applyPlugin,
        MissingInputError: class MissingInputError extends Error {
          fields: string[] = [];
        },
      },
      helpers: {
        requireLocalDaemonRequest: middleware,
        pluginUpload: {
          single: () => middleware,
          array: () => middleware,
        },
        loadPluginRegistryView: async () => {
          registryLoadStarted();
          return registryGate;
        },
        buildConnectorProbe: () => ({}),
        connectorService: {},
        sendApiError: (res: express.Response, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
    } as unknown as Parameters<typeof registerPluginRoutes>[1]);

    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const responsePromise = fetch(`http://127.0.0.1:${port}/api/plugins/team-plugin/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-od-workspace-id': 'ws-team',
        'x-od-workspace-type': 'team',
        'x-od-workspace-member-id': 'member-team',
        'x-od-workspace-role': 'member',
        'x-od-workspace-lifecycle-state': 'active',
        'x-od-workspace-member-status': 'active',
      },
      body: '{}',
    });
    await registryStarted;
    bindingLive = false;
    finishRegistryLoad({});

    const response = await responsePromise;
    expect(response.status).toBe(404);
    expect(applyPlugin).not.toHaveBeenCalled();
  });

  it('resolves exact local Team context from its source instead of current Workspace headers', async () => {
    const app = express();
    app.use(express.json());
    const registryFor = (scope?: { workspaceId?: string }) => ({
      skills: scope?.workspaceId === 'ws-a'
        ? [{ id: 'team-skill', title: 'Team Skill' }]
        : [],
      designSystems: scope?.workspaceId === 'ws-a'
        ? [{ id: 'user:team-system', title: 'Team System' }]
        : [],
      craft: [],
      atoms: [],
      scenarios: [],
    });
    const loadPluginRegistryView = vi.fn(async (scope?: { workspaceId?: string }) =>
      registryFor(scope));
    const applyPlugin = vi.fn(applyPluginCore);
    const teamPlugin: InstalledPluginRecord = {
      id: 'shared-id',
      title: 'Team plugin',
      version: '1.0.0',
      sourceKind: 'user',
      source: 'team:plugin:ws-a:shared-id',
      trust: 'trusted',
      capabilitiesGranted: [],
      fsPath: '/tmp/team-plugin',
      installedAt: 1,
      updatedAt: 1,
      manifest: {
        name: 'shared-id',
        title: 'Team plugin',
        version: '1.0.0',
        od: {
          kind: 'skill',
          context: {
            skills: [{ ref: 'team-skill' }],
            designSystem: { ref: 'user:team-system' },
          },
        },
      },
    };
    const middleware: express.RequestHandler = (_req, _res, next) => next();

    registerPluginRoutes(app, {
      db: {
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
        transaction: (run: () => unknown) => () => run(),
      },
      paths: { PROJECTS_DIR: '', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
      ids: { randomId: () => 'unused' },
      projectStore: {},
      conversations: {},
      plugins: {
        getInstalledPlugin: () => ({
          id: 'shared-id',
          source: 'local:personal:shared-id',
        }),
        getWorkspacePlugin: async () => null,
        getLocalPluginBySource: async (_db: unknown, id: string, source: string) =>
          id === 'shared-id' && source === 'team:plugin:ws-a:shared-id'
            ? teamPlugin
            : null,
        listInstalledPlugins: () => [],
        applyPlugin,
        MissingInputError: class MissingInputError extends Error {
          fields: string[] = [];
        },
      },
      helpers: {
        requireLocalDaemonRequest: middleware,
        pluginUpload: {
          single: () => middleware,
          array: () => middleware,
        },
        loadPluginRegistryView,
        buildConnectorProbe: () => ({}),
        connectorService: {},
        sendApiError: (res: express.Response, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
    } as unknown as Parameters<typeof registerPluginRoutes>[1]);

    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/plugins/shared-id/apply-local`,
      {
        method: 'POST',
        // The current project/session may belong to another Workspace. Exact
        // local refs must still follow the selected plugin's source provenance.
        headers: {
          'content-type': 'application/json',
          'x-od-workspace-id': 'ws-current-project',
          'x-od-workspace-member-id': 'member-current-project',
        },
        body: JSON.stringify({
          source: 'team:plugin:ws-a:shared-id',
          inputs: {},
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json() as ApplyResult & {
      manifestSourceDigest: string;
      ok: true;
    };
    expect(body).toMatchObject({
      ok: true,
      contextItems: [
        { kind: 'skill', id: 'team-skill' },
        { kind: 'design-system', id: 'user:team-system' },
      ],
      appliedPlugin: {
        resolvedContext: {
          items: [
            { kind: 'skill', id: 'team-skill' },
            { kind: 'design-system', id: 'user:team-system' },
          ],
        },
      },
    });
    expect(body.manifestSourceDigest).toBe(applyPluginCore({
      plugin: teamPlugin,
      inputs: {},
      registry: registryFor({ workspaceId: 'ws-a' }),
    }).manifestSourceDigest);
    expect(body.manifestSourceDigest).not.toBe(applyPluginCore({
      plugin: teamPlugin,
      inputs: {},
      registry: registryFor({ workspaceId: 'ws-current-project' }),
    }).manifestSourceDigest);
    expect(loadPluginRegistryView).toHaveBeenCalledWith({
      workspaceId: 'ws-a',
      workspaceMemberId: null,
    });
    expect(applyPlugin).toHaveBeenCalledWith(expect.objectContaining({
      plugin: expect.objectContaining({ source: 'team:plugin:ws-a:shared-id' }),
    }));
  });

  it('returns 404 when local reconciliation no longer resolves the exact source', async () => {
    const app = express();
    app.use(express.json());
    const applyPlugin = vi.fn();
    const middleware: express.RequestHandler = (_req, _res, next) => next();

    registerPluginRoutes(app, {
      db: {
        prepare: () => ({ all: () => [], get: () => null, run: () => undefined }),
        transaction: (run: () => unknown) => () => run(),
      },
      paths: { PROJECTS_DIR: '', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
      ids: { randomId: () => 'unused' },
      projectStore: {},
      conversations: {},
      plugins: {
        getInstalledPlugin: () => null,
        getWorkspacePlugin: async () => null,
        getLocalPluginBySource: async () => null,
        listInstalledPlugins: () => [],
        applyPlugin,
        MissingInputError: class MissingInputError extends Error {
          fields: string[] = [];
        },
      },
      helpers: {
        requireLocalDaemonRequest: middleware,
        pluginUpload: {
          single: () => middleware,
          array: () => middleware,
        },
        loadPluginRegistryView: async () => ({}),
        buildConnectorProbe: () => ({}),
        connectorService: {},
        sendApiError: (res: express.Response, status: number, code: string, message: string) =>
          res.status(status).json({ error: { code, message } }),
      },
    } as unknown as Parameters<typeof registerPluginRoutes>[1]);

    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/plugins/shared-id/apply-local`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'team:plugin:ws-a:shared-id' }),
      },
    );

    expect(response.status).toBe(404);
    expect(applyPlugin).not.toHaveBeenCalled();
  });
});
