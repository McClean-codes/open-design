import { mkdir } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import {
  createCollabCluster,
  type CollabCluster,
} from '@/playwright/collab-cluster';
import { startFakeCollabHub } from '@/playwright/fake-collab-hub';
import { applyStandardMocks } from '@/playwright/mock-factory';
import { ensureRailOpen } from '@/playwright/rail';
import { expect, test } from '@/playwright/suite';

const WORKSPACE_ID = 'ws-multi-client';
const PROJECT_NAME = 'Realtime shared workspace';
// A freshly pulled read-only mirror uses the compact design-file iframe before
// the richer FileViewer test-id variants mount. There is exactly one visible
// artifact iframe in this flow.
const PREVIEW_SELECTOR = 'iframe:visible';

const OWNER = {
  controlKey: 'multi-client-owner-key',
  memberId: 'mem-multi-owner',
  name: 'Olivia Owner',
  role: 'owner' as const,
};
const MEMBER = {
  controlKey: 'multi-client-member-key',
  memberId: 'mem-multi-viewer',
  name: 'Mina Member',
  role: 'member' as const,
};

test.describe.configure({ timeout: 300_000 });

test('[P0] two isolated clients converge live content, presence, and owner unshare', async ({
  browser,
}, testInfo) => {
  const hubRoot = testInfo.outputPath('fake-collab-hub');
  await mkdir(hubRoot, { recursive: true });
  const hub = await startFakeCollabHub({
    root: hubRoot,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Multi-client team',
    clients: [OWNER, MEMBER],
  });
  const velaBin = await hub.writeVelaBin(testInfo.outputPath('fake-vela-collab'));
  const commonEnv = {
    OD_COLLAB_TRANSPORT: 'vela-cli',
    OD_RESOURCE_TRANSPORT: 'vela-cli',
    OD_TEAM_PROJECTS_TRANSPORT: 'vela-cli',
    OD_WORKSPACE_CONTEXT_SOURCE: 'vela',
    VELA_API_URL: hub.url,
    VELA_BIN: velaBin,
  };
  let cluster: CollabCluster | undefined;
  let failed = false;
  try {
    cluster = await createCollabCluster(browser, testInfo, [
      {
        id: 'owner',
        env: { ...commonEnv, VELA_CONTROL_KEY: OWNER.controlKey },
      },
      {
        id: 'member',
        env: { ...commonEnv, VELA_CONTROL_KEY: MEMBER.controlKey },
      },
    ]);
    const ownerPage = cluster.clients.owner!.page;
    const memberPage = cluster.clients.member!.page;
    await Promise.all([applyStandardMocks(ownerPage), applyStandardMocks(memberPage)]);
    await Promise.all([
      openHomeAndPinWorkspace(ownerPage, OWNER.memberId),
      openHomeAndPinWorkspace(memberPage, MEMBER.memberId),
    ]);

    // Exercise the complete wallet invalidation chain: hub event → daemon
    // authoritative workspace snapshot → the already-open member shell. This
    // must use the exact workspaceMemberId wallet, not the account summary.
    await ensureRailOpen(memberPage);
    await memberPage.getByTestId('entry-nav-account').evaluate((element: HTMLButtonElement) => {
      element.click();
    });
    const memberCredits = memberPage.getByTestId('entry-nav-credits-row');
    await expect(memberCredits).toContainText('$0.00', { timeout: 30_000 });
    hub.setWorkspaceBalance(MEMBER.memberId, '18.50');
    await expect(memberCredits).toContainText('$18.50', { timeout: 30_000 });
    await memberPage.keyboard.press('Escape');

    const projectId = await createProject(ownerPage);
    await writeHtml(ownerPage, projectId, htmlFor('Owner version 1'));

    const share = await ownerPage.request.post(
      `/api/workspaces/${WORKSPACE_ID}/projects/${projectId}/move`,
      {
        data: { visibility: 'team' },
        headers: workspaceHeaders(OWNER),
        timeout: 30_000,
      },
    );
    expect(share.ok(), await share.text()).toBeTruthy();
    await hub.waitForCommand(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'team-projects' &&
        entry.args[1] === 'upsert' &&
        entry.args[2] === projectId,
    );

    await expect.poll(
      async () => {
        const response = await memberPage.request.get('/api/workspace/projects/team', {
          headers: workspaceHeaders(MEMBER),
        });
        const raw = await response.text();
        if (!response.ok()) {
          throw new Error(`member Team catalog ${response.status()}: ${raw}`);
        }
        const body = JSON.parse(raw) as { projects?: Array<{ projectId?: string }> };
        return body.projects?.map((project) => project.projectId) ?? [];
      },
      { timeout: 20_000 },
    ).toContain(projectId);

    await ensureRailOpen(memberPage);
    await memberPage.getByTestId('entry-nav-all-projects').click();
    const memberCard = memberPage.locator(
      `.recent-projects__card[data-project-id="${projectId}"]:visible`,
    );
    await expect(memberCard).toContainText(PROJECT_NAME);
    await memberCard.locator('.recent-projects__card-main').click();
    await expect(memberPage).toHaveURL(new RegExp(`/projects/${projectId}`), {
      timeout: 30_000,
    });
    const memberPreview = memberPage.frameLocator(PREVIEW_SELECTOR);
    const initialMemberPull = await hub.waitForCommand(
      (entry) =>
        entry.memberId === MEMBER.memberId &&
        isProjectPull(entry.args),
      30_000,
    );
    const initialMemberVersion = projectPullVersion(initialMemberPull.args);
    await expect(
      memberPreview.getByRole('heading', { name: 'Owner version 1' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(memberPage.getByTestId('workspace-focus-toggle')).toBeVisible({
      timeout: 20_000,
    });
    await expect(memberPage.getByTestId('chat-collapse-toggle')).toBeHidden();
    await memberPage.getByTestId('workspace-focus-toggle').click();
    await expect(memberPage.getByTestId('workspace-focus-toggle')).toHaveCount(0);
    await expect(memberPage.getByTestId('chat-collapse-toggle')).toBeVisible();
    const twoPersonPresence = memberPage.getByRole('group', {
      name: /2 collaborators online/i,
    });
    await expect(twoPersonPresence).toHaveCount(0);

    await ownerPage.goto(`/projects/${projectId}`, { waitUntil: 'domcontentloaded' });
    await expect(ownerPage.getByTestId('file-workspace')).toBeVisible({
      timeout: 30_000,
    });
    await expect(ownerPage.getByTestId('workspace-focus-toggle')).toHaveCount(0);
    await expect(ownerPage.getByTestId('chat-collapse-toggle')).toBeVisible();
    await hub.waitForCommand(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'collab' &&
        entry.args[1] === 'presence' &&
        entry.args[2] === 'heartbeat' &&
        entry.args[3] === projectId,
      30_000,
    );
    await expect(twoPersonPresence).toBeVisible({
      timeout: 20_000,
    });
    await expect(twoPersonPresence.locator('[data-self="true"]')).toHaveCount(1);
    await expect(twoPersonPresence.locator('[title]')).toHaveCount(2);

    const memberDocumentMarker = await memberPage.evaluate(() => {
      const target = window as Window & typeof globalThis & {
        __multiClientDocumentMarker?: string;
      };
      target.__multiClientDocumentMarker = crypto.randomUUID();
      return target.__multiClientDocumentMarker;
    });
    const previousPushCount = hub.commandLog.filter(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'resource' &&
        entry.args[1] === 'push',
    ).length;
    const previousPublishedVersion = hub.eventLog.reduce(
      (latest, event) =>
        event.type === 'project-content-changed' &&
        event.projectId === projectId &&
        typeof event.version === 'number'
          ? Math.max(latest, event.version)
          : latest,
      initialMemberVersion,
    );

    // This write travels to the owner daemon over its real project-file route.
    // The publish watcher pushes it through Vela; the hub event makes the
    // member daemon replace its local mirror directory and emit file-changed
    // to the already-open browser.
    await writeHtml(ownerPage, projectId, htmlFor('Owner version 2'));
    await expect.poll(
      () =>
        hub.commandLog.filter(
          (entry) =>
            entry.memberId === OWNER.memberId &&
            entry.args[0] === 'resource' &&
            entry.args[1] === 'push',
        ).length,
      { timeout: 20_000 },
    ).toBeGreaterThan(previousPushCount);
    const contentEvent = await hub.waitForEvent(
      (entry) =>
        entry.type === 'project-content-changed' &&
        entry.projectId === projectId &&
        typeof entry.version === 'number' &&
        entry.version > previousPublishedVersion,
    );
    await hub.waitForCommand(
      (entry) =>
        entry.memberId === MEMBER.memberId &&
        isProjectPull(entry.args) &&
        projectPullVersion(entry.args) > initialMemberVersion,
      30_000,
    );

    await expect(
      memberPreview.getByRole('heading', { name: 'Owner version 2' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      memberPreview.getByRole('heading', { name: 'Owner version 1' }),
    ).toHaveCount(0);
    await expect.poll(() =>
      memberPage.evaluate(() =>
        (window as Window & typeof globalThis & {
          __multiClientDocumentMarker?: string;
        }).__multiClientDocumentMarker ?? null,
      )
    ).toBe(memberDocumentMarker);
    // Expanding is sticky for this project visit: content/status events after
    // the initial confirmed non-owner default must never collapse chat again.
    await expect(memberPage.getByTestId('workspace-focus-toggle')).toHaveCount(0);
    await expect(memberPage.getByTestId('chat-collapse-toggle')).toBeVisible();

    const memberFile = await memberPage.request.get(
      `/api/projects/${projectId}/files/index.html`,
      { headers: workspaceHeaders(MEMBER) },
    );
    const memberFileBody = await memberFile.text();
    expect(memberFile.ok(), memberFileBody).toBeTruthy();
    expect(memberFileBody).toContain('Owner version 2');
    expect(contentEvent.workspaceId).toBe(WORKSPACE_ID);

    // Drop only the member daemon's hub stream, then publish two complete
    // versions while it is offline. Reconnect catch-up must read the current
    // authoritative head (v4), not depend on replaying either missed event.
    hub.setEventsAvailable(MEMBER.memberId, false);
    await expect.poll(() => hub.eventSubscriberCount(MEMBER.memberId)).toBe(0);
    const pushCountBeforeOfflineWrites = hub.commandLog.filter(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'resource' &&
        entry.args[1] === 'push',
    ).length;
    await writeHtml(ownerPage, projectId, htmlFor('Owner version 3 while member offline'));
    await expect.poll(
      () => hub.commandLog.filter(
        (entry) =>
          entry.memberId === OWNER.memberId &&
          entry.args[0] === 'resource' &&
          entry.args[1] === 'push',
      ).length,
      { timeout: 20_000 },
    ).toBeGreaterThan(pushCountBeforeOfflineWrites);
    const version3Event = await hub.waitForEvent(
      (entry) =>
        entry.type === 'project-content-changed' &&
        entry.projectId === projectId &&
        typeof entry.version === 'number' &&
        entry.version > (contentEvent.version ?? 0),
    );
    const pushCountAfterVersion3 = hub.commandLog.filter(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'resource' &&
        entry.args[1] === 'push',
    ).length;
    await writeHtml(ownerPage, projectId, htmlFor('Owner version 4 while member offline'));
    await expect.poll(
      () => hub.commandLog.filter(
        (entry) =>
          entry.memberId === OWNER.memberId &&
          entry.args[0] === 'resource' &&
          entry.args[1] === 'push',
      ).length,
      { timeout: 20_000 },
    ).toBeGreaterThan(pushCountAfterVersion3);
    const version4Event = await hub.waitForEvent(
      (entry) =>
        entry.type === 'project-content-changed' &&
        entry.projectId === projectId &&
        typeof entry.version === 'number' &&
        entry.version > (version3Event.version ?? 0),
    );
    await expect(
      memberPreview.getByRole('heading', { name: 'Owner version 2' }),
    ).toBeVisible();

    hub.setEventsAvailable(MEMBER.memberId, true);
    await expect.poll(
      () => hub.eventSubscriberCount(MEMBER.memberId),
      { timeout: 30_000 },
    ).toBeGreaterThan(0);
    await hub.waitForCommand(
      (entry) =>
        entry.memberId === MEMBER.memberId &&
        isProjectPull(entry.args) &&
        projectPullVersion(entry.args) >= (version4Event.version ?? Number.MAX_SAFE_INTEGER),
      30_000,
    );
    await expect(
      memberPreview.getByRole('heading', { name: 'Owner version 4 while member offline' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      memberPreview.getByRole('heading', { name: 'Owner version 3 while member offline' }),
    ).toHaveCount(0);
    await expect.poll(() =>
      memberPage.evaluate(() =>
        (window as Window & typeof globalThis & {
          __multiClientDocumentMarker?: string;
        }).__multiClientDocumentMarker ?? null,
      )
    ).toBe(memberDocumentMarker);

    // A title edit is catalog metadata, not project content. Drive the real
    // owner contenteditable and require the already-open read-only member view
    // to follow the metadata event without a file publish or page reload.
    const pushCountBeforeRename = hub.commandLog.filter(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'resource' &&
        entry.args[1] === 'push',
    ).length;
    const renamedProject = 'Realtime shared workspace renamed';
    const ownerTitle = ownerPage.getByTestId('project-title');
    await ownerTitle.fill(renamedProject);
    await ownerTitle.press('Enter');
    await expect(ownerTitle).toContainText(renamedProject);
    await hub.waitForCommand(
      (entry) => {
        const displayNameIndex = entry.args.indexOf('--display-name');
        return (
          entry.memberId === OWNER.memberId &&
          entry.args[0] === 'team-projects' &&
          entry.args[1] === 'upsert' &&
          entry.args[2] === projectId &&
          displayNameIndex >= 0 &&
          entry.args[displayNameIndex + 1] === renamedProject
        );
      },
      30_000,
    );
    await expect(memberPage.getByTestId('project-title')).toContainText(
      renamedProject,
      { timeout: 30_000 },
    );
    expect(hub.commandLog.filter(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'resource' &&
        entry.args[1] === 'push',
    )).toHaveLength(pushCountBeforeRename);
    await expect.poll(() =>
      memberPage.evaluate(() =>
        (window as Window & typeof globalThis & {
          __multiClientDocumentMarker?: string;
        }).__multiClientDocumentMarker ?? null,
      )
    ).toBe(memberDocumentMarker);

    await memberPage.getByTestId('board-mode-toggle').click();
    await memberPage.getByTestId('comment-panel-toggle').click();
    await memberPreview.locator('[data-od-id="shared-heading"]').click();
    const memberComment = memberPage.getByTestId('comment-popover');
    await expect(memberComment).toBeVisible();
    await memberComment.getByTestId('comment-popover-input').fill('Member review note');
    await memberComment.getByTestId('comment-popover-save').click();
    await expect(
      memberPage.getByTestId('comment-side-item').filter({ hasText: 'Member review note' }),
    ).toBeVisible();
    await hub.waitForCommand(
      (entry) =>
        entry.memberId === MEMBER.memberId &&
        entry.args[0] === 'collab' &&
        entry.args[1] === 'comment' &&
        entry.args[2] === 'push' &&
        entry.args[3] === projectId,
      20_000,
    );

    // The owner receives the member-authored comment through the shared relay,
    // while the member remains read-only for project content.
    await ownerPage.getByTestId('comment-panel-toggle').click();
    await expect(
      ownerPage.getByTestId('comment-side-item').filter({ hasText: 'Member review note' }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      ownerPage.getByTestId('comment-side-item').filter({ hasText: MEMBER.name }),
    ).toBeVisible();
    await expect(
      memberPage.getByRole('button', { name: 'Version history' }),
    ).toHaveCount(0);

    const pushCountBeforeUnshare = hub.commandLog.filter(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'resource' &&
        entry.args[1] === 'push',
    ).length;
    const unshare = await ownerPage.request.post(
      `/api/workspaces/${WORKSPACE_ID}/projects/${projectId}/move`,
      {
        data: { visibility: 'personal' },
        headers: workspaceHeaders(OWNER),
        timeout: 30_000,
      },
    );
    expect(unshare.ok(), await unshare.text()).toBeTruthy();
    await hub.waitForCommand(
      (entry) =>
        entry.memberId === OWNER.memberId &&
        entry.args[0] === 'team-projects' &&
        entry.args[1] === 'remove' &&
        entry.args[2] === projectId,
      30_000,
    );

    // A non-creator's local copy is a Team mirror, not their own draft. Once
    // the owner unshares it, quarantine that mirror: it must disappear from
    // every project list and must never be reclassified as Personal.
    await expect.poll(
      async () => {
        const response = await memberPage.request.get('/api/workspace/projects/team', {
          headers: workspaceHeaders(MEMBER),
        });
        const raw = await response.text();
        if (!response.ok()) {
          throw new Error(`member Team catalog ${response.status()}: ${raw}`);
        }
        const body = JSON.parse(raw) as { projects?: Array<{ projectId?: string }> };
        return body.projects?.map((project) => project.projectId) ?? [];
      },
      { timeout: 30_000 },
    ).not.toContain(projectId);
    await expect.poll(
      async () => {
        const response = await memberPage.request.get(
          `/api/workspaces/${WORKSPACE_ID}/projects`,
          { headers: workspaceHeaders(MEMBER) },
        );
        if (!response.ok()) return null;
        const body = await response.json() as {
          projects?: Array<{ id?: string; visibility?: string }>;
        };
        return body.projects?.find((project) => project.id === projectId) ?? null;
      },
      { timeout: 30_000 },
    ).toBeNull();

    await memberPage.goto('/', { waitUntil: 'domcontentloaded' });
    await ensureRailOpen(memberPage);
    await memberPage.getByTestId('entry-nav-all-projects').click();
    await expect(memberCard).toHaveCount(0);
    await memberPage.getByTestId('entry-nav-drafts').click();
    const quarantinedMirror = memberPage.locator(
      `.recent-projects__card[data-project-id="${projectId}"]:visible`,
    );
    await expect(quarantinedMirror).toHaveCount(0);

    await writeHtml(ownerPage, projectId, htmlFor('Owner version 3 after unshare'));
    await expect.poll(
      () =>
        hub.commandLog.filter(
          (entry) =>
            entry.memberId === OWNER.memberId &&
            entry.args[0] === 'resource' &&
            entry.args[1] === 'push',
        ).length,
      { timeout: 5_000 },
    ).toBe(pushCountBeforeUnshare);
    const retainedMemberFile = await memberPage.request.get(
      `/api/projects/${projectId}/files/index.html`,
      { headers: workspaceHeaders(MEMBER) },
    );
    expect(retainedMemberFile.status()).toBe(404);

    // Finally revoke the member's workspace membership while their browser is
    // still open. The hub invalidation must clear the stale team pin, recover
    // to the account's personal workspace, and make the removed team
    // impossible to select again without a reload or sign-out cycle.
    hub.removeMember(MEMBER.memberId);
    await expect.poll(
      async () => {
        const directoryResponse = await memberPage.request.get('/api/workspace/directory');
        if (!directoryResponse.ok()) return null;
        const directory = await directoryResponse.json() as {
          items?: Array<{
            workspaceId?: string;
            workspaceMemberId?: string;
            workspaceType?: string;
          }>;
        };
        const personal = directory.items?.find(
          (item) => item.workspaceType === 'personal',
        );
        if (!personal?.workspaceId || !personal.workspaceMemberId) return null;
        const response = await memberPage.request.get('/api/workspace/context', {
          headers: {
            'x-od-workspace-id': personal.workspaceId,
            'x-od-workspace-member-id': personal.workspaceMemberId,
          },
        });
        if (!response.ok()) return null;
        const body = await response.json() as {
          context?: { workspaceId?: string; workspaceType?: string } | null;
        };
        return body.context ?? null;
      },
      { timeout: 30_000 },
    ).toMatchObject({
      workspaceId: `personal-${MEMBER.memberId}`,
      workspaceType: 'personal',
    });
    await memberPage.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(memberPage.getByTestId('workspace-switcher')).toContainText(
      `${MEMBER.name} workspace`,
      { timeout: 30_000 },
    );
    await expect(memberPage.getByTestId('entry-nav-all-projects')).toHaveCount(0);
    const staleTeamReselect = await memberPage.request.put('/api/workspace/active', {
      data: { workspaceId: WORKSPACE_ID, workspaceMemberId: MEMBER.memberId },
    });
    expect(staleTeamReselect.status()).toBe(404);
  } catch (error) {
    failed = true;
    await testInfo.attach('fake-collab-hub-log', {
      body: JSON.stringify({
        commands: hub.commandLog,
        events: hub.eventLog,
      }, null, 2),
      contentType: 'application/json',
    });
    throw error;
  } finally {
    await cluster?.close({ preserve: failed });
    await hub.close();
  }
});

async function openHomeAndPinWorkspace(page: Page, workspaceMemberId: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Loading Open Design…')).toHaveCount(0, {
    timeout: 60_000,
  });
  const privacyDialog = page
    .getByRole('dialog')
    .filter({ hasText: 'Help us improve Open Design' });
  if (await privacyDialog.isVisible().catch(() => false)) {
    await privacyDialog
      .getByRole('button', { name: /I get it|not now|got it|don't share/i })
      .click();
  }
  const response = await page.request.put('/api/workspace/active', {
    data: { workspaceId: WORKSPACE_ID, workspaceMemberId },
    timeout: 15_000,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Loading Open Design…')).toHaveCount(0, {
    timeout: 60_000,
  });
}

async function createProject(page: Page): Promise<string> {
  const id = `multi-client-${Date.now()}`;
  const response = await page.request.post('/api/projects', {
    data: {
      id,
      name: PROJECT_NAME,
      skillId: null,
      designSystemId: null,
      metadata: { kind: 'prototype' },
    },
    headers: workspaceHeaders(OWNER),
    timeout: 20_000,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const body = await response.json() as { project?: { id?: string } };
  if (!body.project?.id) {
    throw new Error(`project create response missing id: ${JSON.stringify(body)}`);
  }
  return body.project.id;
}

async function writeHtml(page: Page, projectId: string, content: string): Promise<void> {
  const response = await page.request.post(`/api/projects/${projectId}/files`, {
    data: {
      name: 'index.html',
      content,
      artifactManifest: {
        version: 1,
        kind: 'html',
        title: PROJECT_NAME,
        entry: 'index.html',
        renderer: 'html',
        exports: ['html'],
      },
    },
    headers: workspaceHeaders(OWNER),
    timeout: 20_000,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

function workspaceHeaders(identity: typeof OWNER | typeof MEMBER): Record<string, string> {
  return {
    'x-od-workspace-id': WORKSPACE_ID,
    'x-od-workspace-type': 'team',
    'x-od-workspace-member-id': identity.memberId,
    'x-od-workspace-role': identity.role,
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-can-share-projects': identity.role === 'owner' ? 'true' : 'false',
    'x-od-workspace-can-write-synced-files': identity.role === 'owner' ? 'true' : 'false',
  };
}

function htmlFor(heading: string): string {
  return `<!doctype html><html><body><main><h1 data-od-id="shared-heading">${heading}</h1></main></body></html>`;
}

function isProjectPull(args: readonly string[]): boolean {
  return (
    (args[0] === 'team-projects' && args[1] === 'pull') ||
    (args[0] === 'resource' && args[1] === 'pull')
  );
}

function projectPullVersion(args: readonly string[]): number {
  const flagIndex = args.indexOf('--expected-version');
  if (flagIndex >= 0) return Number(args[flagIndex + 1] ?? 0);
  return 0;
}
