import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWorkspaceOwnedDesignSystem } from '../../src/design-systems/workspace-owned-create.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createWorkspaceOwnedDesignSystem', () => {
  it('removes the just-created directory when the Workspace envelope write fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-workspace-owned-ds-'));
    roots.push(root);
    const ensureWorkspaceResource = vi.fn(() => {
      throw new Error('injected workspace_resources failure');
    });

    await expect(
      createWorkspaceOwnedDesignSystem(
        root,
        { title: 'Rollback fixture', artifactMode: 'agent-managed' },
        {
          workspaceId: 'ws-rollback',
          appUserId: 'user-rollback',
          workspaceMemberId: 'member-rollback',
          workspaceType: 'team',
          workspaceTypeAsserted: 'team',
          role: 'member',
          memberStatus: 'active',
          lifecycleState: 'active',
          canShareProjects: true,
          canWriteSyncedFiles: true,
        },
        { ensureWorkspaceResource },
      ),
    ).rejects.toThrow('injected workspace_resources failure');

    expect(ensureWorkspaceResource).toHaveBeenCalledWith(
      'design_system',
      'ws-rollback',
      expect.stringMatching(/^user:/),
      {
        visibility: 'personal',
        resourceState: 'active',
        createdByWorkspaceMemberId: 'member-rollback',
        updatedByWorkspaceMemberId: 'member-rollback',
      },
    );
    expect(await readdir(root)).toEqual([]);
  });

  it('preserves headerless local creation without a Workspace envelope', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'od-local-owned-ds-'));
    roots.push(root);
    const ensureWorkspaceResource = vi.fn();

    const created = await createWorkspaceOwnedDesignSystem(
      root,
      { title: 'Local fixture', artifactMode: 'agent-managed' },
      null,
      { ensureWorkspaceResource },
    );

    expect(ensureWorkspaceResource).not.toHaveBeenCalled();
    await expect(access(path.join(root, created.id.slice('user:'.length), 'metadata.json')))
      .resolves.toBeUndefined();
  });
});
