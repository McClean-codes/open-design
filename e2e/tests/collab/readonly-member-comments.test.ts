// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { requestJson } from '@/vitest/http';
import { createSmokeSuite } from '@/vitest/suite';

const WORKSPACE_ID = 'ws-readonly-comments';
const OWNER_MEMBER_ID = 'mem-comment-owner';
const VIEWER_MEMBER_ID = 'mem-comment-viewer';

type DirectoryMember = {
  workspaceId: string;
  workspaceName: string;
  workspaceType: 'team';
  workspaceMemberId: string;
  role: 'owner' | 'member';
  memberStatus: 'active';
  lifecycleState: 'active';
};

const owner: DirectoryMember = {
  workspaceId: WORKSPACE_ID,
  workspaceName: 'Comment team',
  workspaceType: 'team',
  workspaceMemberId: OWNER_MEMBER_ID,
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
};
const viewer: DirectoryMember = {
  ...owner,
  workspaceMemberId: VIEWER_MEMBER_ID,
  role: 'member',
};

let directoryServer: Server;
let directoryUrl: string;
let directoryMember: DirectoryMember = owner;

beforeAll(async () => {
  directoryServer = createServer((req, res) => {
    if (req.url?.startsWith('/api/v1/workspaces') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: [directoryMember] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>((resolve) => directoryServer.listen(0, '127.0.0.1', resolve));
  const address = directoryServer.address();
  if (address == null || typeof address === 'string') throw new Error('mock comment directory has no port');
  directoryUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => directoryServer.close(() => resolve()));
});

function workspaceHeaders(member: DirectoryMember): Record<string, string> {
  return {
    'x-od-workspace-id': member.workspaceId,
    'x-od-workspace-type': member.workspaceType,
    'x-od-workspace-member-id': member.workspaceMemberId,
    'x-od-workspace-role': member.role,
    'x-od-workspace-lifecycle-state': member.lifecycleState,
    'x-od-workspace-member-status': member.memberStatus,
    'x-od-workspace-can-share-projects': 'true',
    // A read-only shared-project viewer cannot write project files, but must
    // still be able to use the separate comment capability.
    'x-od-workspace-can-write-synced-files': member.role === 'owner' ? 'true' : 'false',
  };
}

const COMMENT_TARGET = {
  filePath: 'index.html',
  elementId: 'hero',
  selector: '[data-od-id="hero"]',
  label: 'h1.hero',
  text: 'Hero',
  htmlHint: '<h1>',
  position: { x: 0, y: 0, width: 0, height: 0 },
};

describe('readonly shared-project comments', () => {
  test(
    'allows an active non-owner to create and manage their comment without opening project writes',
    { timeout: 300_000 },
    async () => {
      const suite = await createSmokeSuite('collab-readonly-member-comments');
      directoryMember = owner;

      await suite.with.toolsDev(
        async ({ webUrl }) => {
          await requestJson(webUrl, '/api/workspace/context', {
            method: 'PUT',
            body: {
              ...owner,
              billingState: 'active',
              planId: 'team_plus',
              providerMode: 'platform_credits',
              seatSummary: { seatLimit: 5, usedSeats: 2 },
            },
          });

          const created = await requestJson<{
            conversationId: string;
            project: { id: string };
          }>(webUrl, '/api/projects', {
            method: 'POST',
            headers: workspaceHeaders(owner),
            body: {
              id: randomUUID(),
              name: 'Owner shared project',
              designSystemId: null,
              skillId: null,
              metadata: { kind: 'prototype' },
              pendingPrompt: null,
            },
          });

          const share = await fetch(
            new URL(
              `/api/workspaces/${WORKSPACE_ID}/projects/${created.project.id}/move`,
              webUrl,
            ),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...workspaceHeaders(owner) },
              body: JSON.stringify({ visibility: 'team' }),
            },
          );
          expect(share.status).toBe(200);

          const commentsPath = `/api/projects/${created.project.id}/conversations/${created.conversationId}/comments`;
          const ownerCommentResponse = await fetch(new URL(commentsPath, webUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...workspaceHeaders(owner) },
            body: JSON.stringify({ target: COMMENT_TARGET, note: 'Owner decision' }),
          });
          expect(ownerCommentResponse.status).toBe(200);
          const ownerComment = await ownerCommentResponse.json() as {
            comment: { id: string; authorMemberId?: string };
          };
          expect(ownerComment.comment.authorMemberId).toBe(OWNER_MEMBER_ID);

          // The membership directory cache is intentionally short-lived. Let
          // the owner proof expire, then model a second account opening the
          // shared project as an ordinary read-only member.
          directoryMember = viewer;
          await requestJson(webUrl, '/api/workspace/context', {
            method: 'PUT',
            body: {
              ...viewer,
              billingState: 'active',
              planId: 'team_plus',
              providerMode: 'platform_credits',
              seatSummary: { seatLimit: 5, usedSeats: 2 },
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 5_200));

          // An ordinary member can comment, but cannot resolve or delete an
          // owner's decision by replaying the same mutation with their own
          // valid workspace identity.
          const patchOwnerComment = await fetch(
            new URL(`${commentsPath}/${ownerComment.comment.id}`, webUrl),
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json', ...workspaceHeaders(viewer) },
              body: JSON.stringify({ status: 'resolved' }),
            },
          );
          expect(patchOwnerComment.status).toBe(403);
          const deleteOwnerComment = await fetch(
            new URL(`${commentsPath}/${ownerComment.comment.id}`, webUrl),
            {
              method: 'DELETE',
              headers: workspaceHeaders(viewer),
            },
          );
          expect(deleteOwnerComment.status).toBe(403);

          const commentResponse = await fetch(new URL(commentsPath, webUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...workspaceHeaders(viewer) },
            body: JSON.stringify({ target: COMMENT_TARGET, note: 'Viewer feedback' }),
          });
          expect(commentResponse.status).toBe(200);
          const commentBody = await commentResponse.json() as {
            comment: { id: string; authorMemberId?: string };
          };
          expect(commentBody.comment.authorMemberId).toBe(VIEWER_MEMBER_ID);

          const patch = await fetch(
            new URL(`${commentsPath}/${commentBody.comment.id}`, webUrl),
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json', ...workspaceHeaders(viewer) },
              body: JSON.stringify({ status: 'resolved' }),
            },
          );
          expect(patch.status).toBe(200);

          const ambientViewer = await fetch(new URL(commentsPath, webUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ target: COMMENT_TARGET, note: 'Ambient viewer write' }),
          });
          expect(ambientViewer.status).toBe(200);

          const foreign = await fetch(new URL(commentsPath, webUrl), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...workspaceHeaders({
                ...viewer,
                workspaceId: 'ws-comment-foreign',
                workspaceMemberId: 'mem-comment-foreign',
              }),
            },
            body: JSON.stringify({ target: COMMENT_TARGET, note: 'Foreign write' }),
          });
          expect(foreign.status).not.toBe(200);

          directoryMember = owner;
          await requestJson(webUrl, '/api/workspace/context', {
            method: 'PUT',
            body: {
              ...owner,
              billingState: 'active',
              planId: 'team_plus',
              providerMode: 'platform_credits',
              seatSummary: { seatLimit: 5, usedSeats: 2 },
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 5_200));

          const commentsAfterRejectedMutations = await fetch(
            new URL(commentsPath, webUrl),
            { headers: workspaceHeaders(owner) },
          );
          expect(commentsAfterRejectedMutations.status).toBe(200);
          const retainedComments = await commentsAfterRejectedMutations.json() as {
            comments: Array<{ id: string; status: string }>;
          };
          expect(retainedComments.comments).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: ownerComment.comment.id, status: 'open' }),
            expect.objectContaining({ id: commentBody.comment.id, status: 'resolved' }),
          ]));

          const unshare = await fetch(
            new URL(
              `/api/workspaces/${WORKSPACE_ID}/projects/${created.project.id}/move`,
              webUrl,
            ),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...workspaceHeaders(owner) },
              body: JSON.stringify({ visibility: 'personal' }),
            },
          );
          expect(unshare.status).toBe(200);

          directoryMember = viewer;
          await requestJson(webUrl, '/api/workspace/context', {
            method: 'PUT',
            body: {
              ...viewer,
              billingState: 'active',
              planId: 'team_plus',
              providerMode: 'platform_credits',
              seatSummary: { seatLimit: 5, usedSeats: 2 },
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 5_200));
          const afterUnshare = await fetch(new URL(commentsPath, webUrl), {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...workspaceHeaders(viewer) },
            body: JSON.stringify({ target: COMMENT_TARGET, note: 'Stale shared access' }),
          });
          expect(afterUnshare.status).toBe(403);
        },
        {
          env: {
            AMR_HOME: `${suite.scratchDir}/empty-amr-home`,
            VELA_API_URL: directoryUrl,
            VELA_CONTROL_KEY: 'e2e-comment-control-key',
          },
        },
      );
    },
  );
});
