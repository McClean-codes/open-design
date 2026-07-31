import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';

import { createToolsDevSuite, e2eWorkspaceRoot } from '../tools-dev/runtime.ts';
import type { ToolsDevSuite } from '../tools-dev/types.ts';

export type CollabClusterClientSpec = {
  id: string;
  env: Record<string, string | undefined>;
};

export type CollabClusterClient = CollabClusterClientSpec & {
  context: BrowserContext;
  page: Page;
  runtime: ToolsDevSuite;
};

export type CollabCluster = {
  clients: Record<string, CollabClusterClient>;
  close: (options?: { preserve?: boolean }) => Promise<void>;
};

/**
 * Start genuinely isolated Open Design clients for collaboration E2E.
 *
 * A second BrowserContext against the normal Playwright worker fixture is not
 * a second client: both pages still share one daemon, sqlite database, project
 * directory and watcher graph. Every entry here gets its own web + daemon,
 * dataDir and browser context while caller-supplied env can point all clients
 * at one shared collaboration authority.
 */
export async function createCollabCluster(
  browser: Browser,
  testInfo: TestInfo,
  specs: readonly CollabClusterClientSpec[],
): Promise<CollabCluster> {
  if (specs.length < 2) {
    throw new Error('a collaboration cluster requires at least two clients');
  }
  const ids = new Set(specs.map((spec) => spec.id));
  if (ids.size !== specs.length) {
    throw new Error('collaboration cluster client ids must be unique');
  }

  const safeTitle = sanitizeSegment(testInfo.titlePath.join('-'));
  const clusterRoot = join(
    e2eWorkspaceRoot(),
    '.tmp',
    'e2e',
    `collab-cluster-${process.pid}-${testInfo.workerIndex}-${safeTitle}`,
  );
  await mkdir(clusterRoot, { recursive: true });

  const started: CollabClusterClient[] = [];
  let closed = false;
  try {
    for (const spec of specs) {
      const root = join(clusterRoot, sanitizeSegment(spec.id));
      const scratchDir = join(root, 'scratch');
      await mkdir(scratchDir, { recursive: true });
      const runtime = createToolsDevSuite({
        codexHomeDir: join(scratchDir, 'codex-home'),
        dataDir: join(scratchDir, 'data'),
        namespace: `collab-${process.pid}-${testInfo.workerIndex}-${sanitizeSegment(spec.id)}`,
        root,
        toolsDevRoot: join(scratchDir, 'tools-dev'),
      });
      await runtime.startWeb(spec.env);
      const context = await browser.newContext({ baseURL: runtime.url.web() });
      const page = await context.newPage();
      started.push({ ...spec, context, page, runtime });
    }
  } catch (error) {
    await closeStartedClients(started, clusterRoot, testInfo, true);
    throw error;
  }

  return {
    clients: Object.fromEntries(started.map((client) => [client.id, client])),
    close: async (options = {}) => {
      if (closed) return;
      closed = true;
      await closeStartedClients(
        started,
        clusterRoot,
        testInfo,
        options.preserve === true || testInfo.status !== testInfo.expectedStatus,
      );
    },
  };
}

async function closeStartedClients(
  clients: readonly CollabClusterClient[],
  clusterRoot: string,
  testInfo: TestInfo,
  preserve: boolean,
): Promise<void> {
  for (const client of [...clients].reverse()) {
    await client.context.close().catch(() => undefined);
    if (preserve) {
      const logs = await client.runtime.logs(client.env).catch(() => null);
      if (logs) {
        await testInfo.attach(`collab-${client.id}-runtime-logs`, {
          body: JSON.stringify(logs, null, 2),
          contentType: 'application/json',
        });
      }
    }
    await client.runtime.stopWeb(client.env).catch(() => undefined);
  }
  if (!preserve) {
    await rm(clusterRoot, { force: true, recursive: true });
  }
}

function sanitizeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe.slice(0, 80) || 'client';
}
