// @vitest-environment node

import { chmod, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite } from '@/vitest/suite';

const PERSONAL = {
  workspaceId: 'ws-switch-personal',
  workspaceName: 'Ada workspace',
  workspaceType: 'personal' as const,
  workspaceMemberId: 'mem-switch-personal',
  role: 'owner' as const,
  memberStatus: 'active' as const,
  lifecycleState: 'active' as const,
};

const TEAM = {
  workspaceId: 'ws-switch-team',
  workspaceName: 'Ada team',
  workspaceType: 'team' as const,
  workspaceMemberId: 'mem-switch-team',
  role: 'owner' as const,
  memberStatus: 'active' as const,
  lifecycleState: 'active' as const,
};

let authority: Server;
let authorityUrl: string;
let directoryItems = [PERSONAL, TEAM];
let teamCurrentUnavailable = false;

beforeAll(async () => {
  authority = createServer((req, res) => {
    if (req.url === '/api/v1/workspaces' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: directoryItems }));
      return;
    }
    if (req.url === '/api/v1/workspaces/current' && req.method === 'GET') {
      const workspaceId = req.headers['x-vela-workspace-id'];
      const current = workspaceId === TEAM.workspaceId ? TEAM : PERSONAL;
      if (!workspaceId || (workspaceId === TEAM.workspaceId && teamCurrentUnavailable)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_principal' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ...current,
        billingState: current.workspaceType === 'team' ? 'active' : 'free',
        planId: current.workspaceType === 'team' ? 'team_plus' : null,
        providerMode: 'platform_credits',
        seatSummary: current.workspaceType === 'team'
          ? { seatLimit: 5, usedSeats: 1 }
          : { seatLimit: 1, usedSeats: 1 },
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => authority.listen(0, '127.0.0.1', resolve));
  const address = authority.address();
  if (address == null || typeof address === 'string') throw new Error('mock authority has no port');
  authorityUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => authority.close(() => resolve()));
});

async function writeBillingVelaBin(path: string): Promise<string> {
  await writeFile(
    path,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] !== 'billing') process.exit(1);
if (args[1] === 'summary') {
  process.stdout.write(JSON.stringify({
    membershipTier: 'free',
    balanceUsd: '0.00',
    subscriptionStatus: 'inactive',
    balances: { totalAvailableCredits: 0, subscriptionCredits: 0, rechargeCredits: 0 },
    availableActions: [],
  }) + '\\n');
  process.exit(0);
}
if (args[1] === 'workspace-snapshot') {
  const workspaceId = args[args.indexOf('--workspace-id') + 1];
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    workspaceId,
    workspaceMemberId: 'mem-switch-team',
    billingScopeVersion: 2,
    billing: { billingState: 'active', planId: 'team_plus' },
    wallet: { balanceUsd: '12.50', expiresAt: null, updatedAt: '2026-07-31T00:00:00Z' },
    revisions: { billing: 'billing-1', wallet: 'wallet-1' },
  }) + '\\n');
  process.exit(0);
}
if (args[1] === 'checkout') {
  process.stdout.write(JSON.stringify({ checkoutUrl: 'https://billing.example/checkout/team-1' }) + '\\n');
  process.exit(0);
}
process.exit(1);
`,
    'utf8',
  );
  await chmod(path, 0o755);
  return path;
}

async function expectStatus(
  webUrl: string,
  path: string,
  expected: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, `${webUrl}/`));
  expect(response.status).toBe(expected);
  return (await response.json()) as Record<string, unknown>;
}

describe('workspace switching and scoped billing', () => {
  test(
    'switches the local workspace and never authorizes personal or foreign billing scopes',
    { timeout: 240_000 },
    async () => {
      const suite = await createSmokeSuite('collab-workspace-switch-and-billing');
      directoryItems = [PERSONAL, TEAM];
      teamCurrentUnavailable = false;
      const velaBin = await writeBillingVelaBin(join(suite.scratchDir, 'fake-vela-billing'));

      await suite.with.toolsDev(
        async ({ webUrl }) => {
          const initial = await requestJson<{ context: { workspaceId: string } | null }>(
            webUrl,
            '/api/workspace/context',
          );
          expect(initial.context?.workspaceId).toBe(PERSONAL.workspaceId);

          const switched = await requestJson<{
            activeWorkspaceId: string;
            context: { workspaceId: string; workspaceName?: string; workspaceType: string };
          }>(webUrl, '/api/workspace/active', {
            method: 'PUT',
            body: { workspaceId: TEAM.workspaceId },
          });
          expect(switched).toMatchObject({
            activeWorkspaceId: TEAM.workspaceId,
            context: {
              workspaceId: TEAM.workspaceId,
              workspaceName: TEAM.workspaceName,
              workspaceType: 'team',
            },
          });

          const directory = await requestJson<{ activeWorkspaceId: string | null }>(
            webUrl,
            '/api/workspace/directory',
          );
          expect(directory.activeWorkspaceId).toBe(TEAM.workspaceId);

          const billing = await requestJson<{
            summary: { workspaceId: null; membershipTier: string } | null;
            workspaceBalance: { workspaceId: string; workspaceMemberId: string; balanceUsd: string } | null;
            workspaceSnapshot?: { billing: { billingState: string; planId: string | null } };
          }>(webUrl, `/api/workspace/billing?scope=workspace&workspaceId=${TEAM.workspaceId}`);
          expect(billing.summary?.workspaceId).toBeNull();
          expect(billing.workspaceBalance).toMatchObject({
            workspaceId: TEAM.workspaceId,
            workspaceMemberId: TEAM.workspaceMemberId,
            balanceUsd: '12.50',
          });
          expect(billing.workspaceSnapshot).toMatchObject({
            billing: { billingState: 'active', planId: 'team_plus' },
          });

          const checkout = await requestJson<{ checkoutUrl: string | null }>(
            webUrl,
            '/api/workspace/billing/checkout',
            {
              method: 'POST',
              body: { planId: 'team_pro', seats: 3 },
            },
          );
          expect(checkout.checkoutUrl).toBe('https://billing.example/checkout/team-1');

          // A personal workspace is not a team billing subject, even though it
          // is a valid workspace membership for project/editor scope.
          await expectStatus(
            webUrl,
            `/api/workspace/billing?scope=workspace&workspaceId=${PERSONAL.workspaceId}`,
            403,
          );
          await expectStatus(
            webUrl,
            '/api/workspace/billing?scope=workspace&workspaceId=ws-foreign',
            403,
          );
        },
        {
          env: {
            AMR_HOME: join(suite.scratchDir, 'empty-amr-home'),
            OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
            VELA_API_URL: authorityUrl,
            VELA_CONTROL_KEY: 'e2e-switch-control-key',
            VELA_BIN: velaBin,
          },
        },
      );
    },
  );

  test(
    'clears a stale team pin and recovers to the personal workspace after membership removal',
    { timeout: 240_000 },
    async () => {
      const suite = await createSmokeSuite('collab-workspace-stale-pin-recovery');
      directoryItems = [PERSONAL, TEAM];
      teamCurrentUnavailable = false;

      await suite.with.toolsDev(
        async ({ webUrl }) => {
          await requestJson(webUrl, '/api/workspace/context');
          await requestJson(webUrl, '/api/workspace/active', {
            method: 'PUT',
            body: { workspaceId: TEAM.workspaceId },
          });

          // Simulate B confirming that the team membership disappeared. The
          // current endpoint can no longer resolve the pinned principal, while
          // the directory still contains the user's personal workspace.
          directoryItems = [PERSONAL];
          teamCurrentUnavailable = true;

          const recovered = await requestJson<{
            context: {
              workspaceId: string;
              workspaceName?: string;
              workspaceType: string;
            } | null;
          }>(webUrl, '/api/workspace/context');
          expect(recovered.context).toMatchObject({
            workspaceId: PERSONAL.workspaceId,
            workspaceName: PERSONAL.workspaceName,
            workspaceType: 'personal',
          });

          const directory = await requestJson<{ activeWorkspaceId: string | null }>(
            webUrl,
            '/api/workspace/directory',
          );
          expect(directory.activeWorkspaceId).toBe(PERSONAL.workspaceId);
        },
        {
          env: {
            AMR_HOME: join(suite.scratchDir, 'empty-amr-home'),
            OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
            VELA_API_URL: authorityUrl,
            VELA_CONTROL_KEY: 'e2e-stale-pin-control-key',
          },
        },
      );
    },
  );
});
