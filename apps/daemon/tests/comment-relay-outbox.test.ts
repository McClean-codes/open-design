import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type CollabMemberRole,
  type PreviewComment,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
} from '../src/db.js';
import { createCollabCloudService } from '../src/collab/collab-cloud-service.js';
import { createCommentRelayOutboxStore } from '../src/collab/comment-relay-outbox.js';
import type { CollabCloudClient } from '../src/integrations/collab-cloud.js';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function seededDb() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-comment-relay-outbox-'));
  const db = openDatabase(tempDir);
  insertProject(db, { id: 'p1', name: 'Project', createdAt: 1, updatedAt: 1 });
  insertConversation(db, {
    id: 'conv-local',
    projectId: 'p1',
    title: 'Chat',
    createdAt: 1,
    updatedAt: 1,
  });
  return db;
}

function context(
  role: CollabMemberRole = 'member',
  patch: Partial<WorkspaceCollabContext> = {},
): WorkspaceCollabContext {
  return {
    workspaceId: 'workspace-a',
    workspaceType: 'team',
    workspaceMemberId: `member-${role}`,
    role,
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 3 }),
    permissions: buildWorkspacePermissions({ role, lifecycleState: 'active' }),
    teamId: 'team-a',
    displayName: role,
    ...patch,
  };
}

function comment(patch: Partial<PreviewComment> = {}): PreviewComment {
  return {
    id: 'comment-1',
    projectId: 'p1',
    conversationId: 'conv-local',
    filePath: 'index.html',
    elementId: 'hero',
    selector: '#hero',
    label: 'Hero',
    text: 'Hero',
    position: { x: 1, y: 2, width: 3, height: 4 },
    htmlHint: '<h1>',
    note: 'first note',
    status: 'open',
    createdAt: 10,
    updatedAt: 10,
    authorMemberId: 'member-member',
    ...patch,
  };
}

function clientWithPush(
  push: CollabCloudClient['pushComment'],
): CollabCloudClient {
  return { pushComment: push } as unknown as CollabCloudClient;
}

describe('durable Team comment relay outbox', () => {
  it.each<CollabMemberRole>(['owner', 'admin', 'member'])(
    'delivers %s comments under the exact queued Workspace identity',
    async (role) => {
      const db = seededDb();
      const queuedContext = context(role);
      const calls: Array<{ teamId: string; memberId: string }> = [];
      const outbox = createCommentRelayOutboxStore(db, () => 100);
      const service = createCollabCloudService({
        client: clientWithPush(async (teamId, _projectId, payload) => {
          calls.push({ teamId, memberId: payload.memberId });
          return { seq: 7 };
        }),
        commentOutbox: outbox,
        resolveLocalProjectRelayBinding: () => ({
          workspaceId: 'workspace-a',
          ownerMemberId: 'project-owner',
        }),
        resolveRemoteProjectOwnerMemberId: async () => 'project-owner',
        listProjectIds: () => [],
        resolveProjectWorkspaceContext: async (_projectId, options) => {
          expect(options).toEqual({ fresh: true });
          return queuedContext;
        },
        resolveLocalConversationId: () => 'conv-local',
        mergeComment: () => false,
        now: () => 100,
        retryDelayMs: () => 0,
      });

      expect(service.enqueueComment(comment({ authorMemberId: queuedContext.workspaceMemberId }), queuedContext))
        .toBe(true);
      expect(outbox.count()).toBe(1);
      await service.flushPendingComments();

      expect(calls).toEqual([
        { teamId: 'team-a', memberId: queuedContext.workspaceMemberId },
      ]);
      expect(outbox.count()).toBe(0);
      service.dispose();
    },
  );

  it('retries a failed push after restart and confirms the cloud sequence', async () => {
    const db = seededDb();
    const queuedContext = context('member');
    const firstOutbox = createCommentRelayOutboxStore(db, () => 200);
    const firstService = createCollabCloudService({
      client: clientWithPush(async () => {
        throw new Error('Vela TLS unavailable');
      }),
      commentOutbox: firstOutbox,
      resolveLocalProjectRelayBinding: () => ({
        workspaceId: 'workspace-a',
        ownerMemberId: 'project-owner',
      }),
      resolveRemoteProjectOwnerMemberId: async () => 'project-owner',
      listProjectIds: () => [],
      resolveProjectWorkspaceContext: async () => queuedContext,
      resolveLocalConversationId: () => 'conv-local',
      mergeComment: () => false,
      now: () => 200,
      retryDelayMs: () => 0,
    });
    firstService.enqueueComment(comment(), queuedContext);
    await firstService.flushPendingComments();
    expect(firstOutbox.count()).toBe(1);
    firstService.dispose();

    // A new service + newly opened SQLite handle sees and drains the same row.
    closeDatabase();
    const reopened = openDatabase(tempDir!);
    const reopenedOutbox = createCommentRelayOutboxStore(reopened, () => 200);
    const confirmed: Array<{ commentId: string; seq: number }> = [];
    const secondService = createCollabCloudService({
      client: clientWithPush(async () => ({ seq: 42 })),
      commentOutbox: reopenedOutbox,
      resolveLocalProjectRelayBinding: () => ({
        workspaceId: 'workspace-a',
        ownerMemberId: 'project-owner',
      }),
      resolveRemoteProjectOwnerMemberId: async () => 'project-owner',
      listProjectIds: () => [],
      resolveProjectWorkspaceContext: async () => queuedContext,
      resolveLocalConversationId: () => 'conv-local',
      mergeComment: () => false,
      onCommentPushed: ({ commentId, seq }) => confirmed.push({ commentId, seq }),
      now: () => 200,
      retryDelayMs: () => 0,
    });
    await secondService.flushPendingComments();

    expect(reopenedOutbox.count()).toBe(0);
    expect(confirmed).toEqual([{ commentId: 'comment-1', seq: 42 }]);
    secondService.dispose();
  });

  it('retries in the running daemon after the relay recovers', async () => {
    const db = seededDb();
    const queuedContext = context('owner');
    let attempts = 0;
    const outbox = createCommentRelayOutboxStore(db, () => 250);
    const service = createCollabCloudService({
      client: clientWithPush(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary network failure');
        return { seq: 9 };
      }),
      commentOutbox: outbox,
      resolveLocalProjectRelayBinding: () => ({
        workspaceId: 'workspace-a',
        ownerMemberId: 'project-owner',
      }),
      resolveRemoteProjectOwnerMemberId: async () => 'project-owner',
      listProjectIds: () => [],
      resolveProjectWorkspaceContext: async () => queuedContext,
      resolveLocalConversationId: () => 'conv-local',
      mergeComment: () => false,
      now: () => 250,
      retryDelayMs: () => 0,
    });
    service.enqueueComment(comment({ authorMemberId: 'member-owner' }), queuedContext);

    await service.flushPendingComments();
    expect(attempts).toBe(1);
    expect(outbox.count()).toBe(1);
    await service.flushPendingComments();

    expect(attempts).toBe(2);
    expect(outbox.count()).toBe(0);
    service.dispose();
  });

  it('coalesces edits and delete tombstones without losing their latest state', async () => {
    const db = seededDb();
    const queuedContext = context('admin');
    const pushed: Array<{ note: string; deleted: boolean }> = [];
    const outbox = createCommentRelayOutboxStore(db, () => 300);
    const service = createCollabCloudService({
      client: clientWithPush(async (_teamId, _projectId, payload) => {
        pushed.push({ note: payload.note, deleted: payload.deleted === true });
        return { seq: pushed.length };
      }),
      commentOutbox: outbox,
      resolveLocalProjectRelayBinding: () => ({
        workspaceId: 'workspace-a',
        ownerMemberId: 'project-owner',
      }),
      resolveRemoteProjectOwnerMemberId: async () => 'project-owner',
      listProjectIds: () => [],
      resolveProjectWorkspaceContext: async () => queuedContext,
      resolveLocalConversationId: () => 'conv-local',
      mergeComment: () => false,
      now: () => 300,
      retryDelayMs: () => 0,
    });

    service.enqueueComment(comment(), queuedContext);
    service.enqueueComment(comment({ note: 'edited note', updatedAt: 20 }), queuedContext);
    expect(outbox.count()).toBe(1);
    await service.flushPendingComments();
    expect(pushed).toEqual([{ note: 'edited note', deleted: false }]);

    service.enqueueCommentDeletion(comment({ note: 'edited note', updatedAt: 20 }), queuedContext);
    await service.flushPendingComments();
    expect(pushed).toEqual([
      { note: 'edited note', deleted: false },
      { note: 'edited note', deleted: true },
    ]);
    expect(outbox.count()).toBe(0);
    service.dispose();
  });

  it('keeps a row pending across identity, Workspace, and Personal mismatches', async () => {
    const db = seededDb();
    const queuedContext = context('member');
    let resolved = context('member', { workspaceMemberId: 'other-member' });
    let pushes = 0;
    const outbox = createCommentRelayOutboxStore(db, () => 400);
    const service = createCollabCloudService({
      client: clientWithPush(async () => {
        pushes += 1;
        return { seq: 1 };
      }),
      commentOutbox: outbox,
      resolveLocalProjectRelayBinding: () => ({
        workspaceId: 'workspace-a',
        ownerMemberId: 'project-owner',
      }),
      resolveRemoteProjectOwnerMemberId: async () => 'project-owner',
      listProjectIds: () => [],
      resolveProjectWorkspaceContext: async () => resolved,
      resolveLocalConversationId: () => 'conv-local',
      mergeComment: () => false,
      now: () => 400,
      retryDelayMs: () => 0,
    });
    service.enqueueComment(comment(), queuedContext);

    await service.flushPendingComments();
    resolved = context('member', {
      workspaceId: 'workspace-b',
      teamId: 'team-b',
    });
    await service.flushPendingComments();
    resolved = context('member', {
      workspaceType: 'personal',
      workspaceId: 'workspace-personal',
    });
    delete (resolved as Partial<WorkspaceCollabContext>).teamId;
    await service.flushPendingComments();

    expect(pushes).toBe(0);
    expect(outbox.count()).toBe(1);

    resolved = queuedContext;
    await service.flushPendingComments();
    expect(pushes).toBe(1);
    expect(outbox.count()).toBe(0);
    service.dispose();
  });

  it('keeps the delivery pending when the remote catalog is unavailable', async () => {
    const db = seededDb();
    const queuedContext = context('member');
    let pushes = 0;
    const outbox = createCommentRelayOutboxStore(db, () => 500);
    const service = createCollabCloudService({
      client: clientWithPush(async () => {
        pushes += 1;
        return { seq: 1 };
      }),
      commentOutbox: outbox,
      resolveLocalProjectRelayBinding: () => ({
        workspaceId: 'workspace-a',
        ownerMemberId: 'project-owner',
      }),
      resolveRemoteProjectOwnerMemberId: async () => {
        throw new Error('catalog unavailable');
      },
      listProjectIds: () => [],
      resolveProjectWorkspaceContext: async () => queuedContext,
      resolveLocalConversationId: () => 'conv-local',
      mergeComment: () => false,
      now: () => 500,
      retryDelayMs: () => 0,
    });
    service.enqueueComment(comment(), queuedContext);
    await service.flushPendingComments();

    expect(pushes).toBe(0);
    expect(outbox.count()).toBe(1);
    service.dispose();
  });

  it.each([
    { name: 'remote unshare', remoteOwner: null },
    { name: 'remote owner conflict', remoteOwner: 'different-owner' },
  ])('terminally cancels after $name without pushing', async ({ remoteOwner }) => {
    const db = seededDb();
    const queuedContext = context('admin');
    let pushes = 0;
    const outbox = createCommentRelayOutboxStore(db, () => 600);
    const service = createCollabCloudService({
      client: clientWithPush(async () => {
        pushes += 1;
        return { seq: 1 };
      }),
      commentOutbox: outbox,
      resolveLocalProjectRelayBinding: () => ({
        workspaceId: 'workspace-a',
        ownerMemberId: 'project-owner',
      }),
      resolveRemoteProjectOwnerMemberId: async () => remoteOwner,
      listProjectIds: () => [],
      resolveProjectWorkspaceContext: async () => queuedContext,
      resolveLocalConversationId: () => 'conv-local',
      mergeComment: () => false,
      now: () => 600,
      retryDelayMs: () => 0,
    });
    service.enqueueComment(comment(), queuedContext);
    await service.flushPendingComments();

    expect(pushes).toBe(0);
    expect(outbox.count()).toBe(0);
    service.dispose();
  });
});
