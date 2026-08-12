import type Database from 'better-sqlite3';
import type { InstalledPluginRecord } from '@open-design/contracts';
import {
  readTeamResourceMaterialization,
  teamResourceMaterializationDir,
} from '../collab/team-resource-materialization.js';
import { isSafePluginId } from './installer.js';
import {
  getInstalledPlugin,
  resolvePluginFolder,
  resolveWorkspaceTeamPluginWithBindingGate,
  workspaceTeamPluginBindingAllowsRead,
} from './registry.js';

const TEAM_PLUGIN_SOURCE_PREFIX = 'team:plugin:';

function workspaceIdFromTeamPluginSource(
  source: string,
  pluginId: string,
): string | null {
  const suffix = `:${pluginId}`;
  if (!source.startsWith(TEAM_PLUGIN_SOURCE_PREFIX) || !source.endsWith(suffix)) {
    return null;
  }
  const workspaceId = source.slice(
    TEAM_PLUGIN_SOURCE_PREFIX.length,
    -suffix.length,
  ).trim();
  return workspaceId || null;
}

/**
 * Resolve the exact already-local record selected by the user.
 *
 * PRODUCT INVARIANT: local use follows the daemon's locally reconciled catalog;
 * it is not a live Team-authorization operation. A temporarily stale mirror is
 * usable until SSE/polling records its retraction locally. Once the local
 * binding is tombstoned, new applies/creates stop resolving it. Do not add a
 * network membership check or compare this source's historical Workspace with
 * the new project's current Workspace: remote install/pull/sync/share and
 * move-to-Team mutations own those fresh authorization boundaries.
 *
 * `source` is still mandatory because it identifies the user's exact local
 * choice when Personal and Team materializations share the same logical id.
 */
export async function resolveLocalPluginBySource(input: {
  db: Database.Database;
  id: string;
  source: string;
  userPluginsRoot: string;
}): Promise<InstalledPluginRecord | null> {
  const { db, id, source, userPluginsRoot } = input;
  const installed = getInstalledPlugin(db, id);
  if (installed?.source === source) return installed;

  if (!isSafePluginId(id)) return null;
  const workspaceId = workspaceIdFromTeamPluginSource(source, id);
  if (!workspaceId) return null;
  return resolveWorkspaceTeamPluginWithBindingGate({
    bindingAllowsRead: () =>
      workspaceTeamPluginBindingAllowsRead(db, workspaceId, id),
    resolve: async () => {
      const marker = await readTeamResourceMaterialization(
        userPluginsRoot,
        workspaceId,
        id,
        id,
      );
      if (
        !marker
        || marker.kind !== 'plugin'
        || marker.resourceId !== id
        || marker.workspaceId !== workspaceId
        || marker.sourceKey !== source
      ) return null;

      const resolved = await resolvePluginFolder({
        folder: teamResourceMaterializationDir(userPluginsRoot, workspaceId, id, id),
        folderId: id,
        sourceKind: 'user',
        source,
      });
      return resolved.ok ? resolved.record : null;
    },
  });
}
