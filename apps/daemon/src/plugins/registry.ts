// Plugin registry. Phase 1 scope:
//
// - Scans `<daemonDataDir>/plugins/<id>/` (the OD-canonical install root) for
//   manifest folders.
// - Resolves a plugin folder into either an `open-design.json`-anchored
//   manifest or a synthesized one derived from `SKILL.md` /
//   `.claude-plugin/plugin.json` (per spec §3 compatibility matrix).
// - Persists discovered records into the `installed_plugins` SQLite row so
//   subsequent CLI / HTTP calls can read without rescanning the FS.
//
// Phase 2A will add the project-cwd tier and the legacy SKILL.md tiers; we
// keep this module narrow today so the loader / installer split stays
// honest. Adding more tiers is a pure data-source change and never a
// schema migration.

import path from 'node:path';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import {
  adaptAgentSkill,
  adaptClaudePlugin,
  mergeManifests,
  parseManifest,
  validateSafe,
  type ManifestParseResult,
} from '@open-design/plugin-runtime';
import type {
  InstalledPluginRecord,
  MarketplaceTrust,
  PluginManifest,
  PluginSourceKind,
  TrustTier,
} from '@open-design/contracts';
import { defaultTrustForRecord, resolveCapabilitiesGranted } from './trust.js';
import { getWorkspaceResourceByResourceId } from '../db.js';
import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;
type DbRow = Record<string, unknown>;

export interface RegistryRoots {
  // User-installed plugin bytes. Production passes a daemon data-root-derived
  // value; tests can point this at a sandbox.
  userPluginsRoot: string;
}

export function registryRootsForDataDir(dataDir: string): RegistryRoots {
  return {
    userPluginsRoot: path.join(dataDir, 'plugins'),
  };
}

export function defaultRegistryRoots(): RegistryRoots {
  return registryRootsForDataDir(path.resolve(process.env.OD_DATA_DIR ?? path.join(process.cwd(), '.od')));
}

export interface ScannedPlugin {
  record: InstalledPluginRecord;
  warnings: string[];
}

export interface ResolveOptions {
  // The on-disk folder. Used for both reading and computing the manifest's
  // sourceDigest. Phase 2A swaps this to the registry's discovered fsPath.
  folder: string;
  folderId: string;
  sourceKind?: PluginSourceKind;
  source?: string;
  pinnedRef?: string;
  trust?: TrustTier;
  capabilitiesGranted?: string[];
  sourceMarketplaceId?: string;
  sourceMarketplaceEntryName?: string;
  sourceMarketplaceEntryVersion?: string;
  marketplaceTrust?: MarketplaceTrust;
  resolvedSource?: string;
  resolvedRef?: string;
  manifestDigest?: string;
  archiveIntegrity?: string;
}

export interface ResolveOutcome {
  ok: true;
  record: InstalledPluginRecord;
  warnings: string[];
}

export interface ResolveFailure {
  ok: false;
  errors: string[];
  warnings: string[];
}

export type ResolveResult = ResolveOutcome | ResolveFailure;

// Resolve a single plugin folder into a typed InstalledPluginRecord. Pure
// FS read, no SQLite write — the installer module is the only writer.
export async function resolvePluginFolder(opts: ResolveOptions): Promise<ResolveResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const folder = opts.folder;

  let stats: fs.Stats;
  try {
    stats = await fsp.stat(folder);
  } catch (err) {
    return { ok: false, errors: [`Plugin folder not found: ${folder} (${(err as Error).message})`], warnings };
  }
  if (!stats.isDirectory()) {
    return { ok: false, errors: [`Plugin path is not a directory: ${folder}`], warnings };
  }

  const sidecarPath = path.join(folder, 'open-design.json');
  const skillPath = path.join(folder, 'SKILL.md');
  const claudePath = path.join(folder, '.claude-plugin', 'plugin.json');

  let sidecar: PluginManifest | undefined;
  if (fs.existsSync(sidecarPath)) {
    const rawSidecar = await fsp.readFile(sidecarPath, 'utf8');
    const parsed: ManifestParseResult = parseManifest(rawSidecar);
    if (!parsed.ok) {
      errors.push(...parsed.errors.map((e) => `open-design.json: ${e}`));
    } else {
      sidecar = parsed.manifest;
      warnings.push(...parsed.warnings);
    }
  }

  const adapters: PluginManifest[] = [];
  if (fs.existsSync(skillPath)) {
    const raw = await fsp.readFile(skillPath, 'utf8');
    const adapted = adaptAgentSkill(raw, { folderId: opts.folderId });
    adapters.push(adapted.manifest);
    warnings.push(...adapted.warnings);
  }
  if (fs.existsSync(claudePath)) {
    const raw = await fsp.readFile(claudePath, 'utf8');
    const adapted = adaptClaudePlugin(raw, { folderId: opts.folderId });
    adapters.push(adapted.manifest);
    warnings.push(...adapted.warnings);
  }

  if (!sidecar && adapters.length === 0) {
    return {
      ok: false,
      errors: [...errors, `Plugin folder contains no SKILL.md, no .claude-plugin/plugin.json, and no open-design.json: ${folder}`],
      warnings,
    };
  }

  const manifest = mergeManifests({ sidecar, adapters });
  const validation = validateSafe(manifest);
  warnings.push(...validation.warnings);
  if (!validation.ok) {
    return { ok: false, errors: [...errors, ...validation.errors], warnings };
  }

  if (errors.length > 0) {
    return { ok: false, errors, warnings };
  }

  const now = Date.now();
  // The manifest name wins (spec §5.1: plugin id IS the manifest name). The
  // folderId fallback only kicks in when an adapter-only manifest forgot to
  // set name, which Zod validation already rejects.
  const id = (manifest.name ?? opts.folderId).toLowerCase();
  const sourceKind = opts.sourceKind ?? 'local';
  // Spec §5.3 / trust.ts: a `local` install is implicitly trusted (the user
  // copied the folder here themselves), everything else starts restricted
  // until an explicit `od plugin trust` flip. Fall back to that source-kind
  // policy when the caller did not pin a trust tier — previously this was
  // hard-coded to 'restricted', which left local scenario plugins unable to
  // obtain the `pipeline:*` capability they need to run their own pipeline.
  const trust: TrustTier = opts.trust ?? defaultTrustForRecord({ sourceKind });
  const capabilitiesGranted =
    opts.capabilitiesGranted ?? resolveCapabilitiesGranted({ manifest, trust });
  const record: InstalledPluginRecord = {
    id,
    title: manifest.title ?? manifest.name,
    version: manifest.version,
    sourceKind,
    source: opts.source ?? folder,
    pinnedRef: opts.pinnedRef,
    sourceMarketplaceId: opts.sourceMarketplaceId,
    sourceMarketplaceEntryName: opts.sourceMarketplaceEntryName,
    sourceMarketplaceEntryVersion: opts.sourceMarketplaceEntryVersion,
    marketplaceTrust: opts.marketplaceTrust,
    resolvedSource: opts.resolvedSource,
    resolvedRef: opts.resolvedRef,
    manifestDigest: opts.manifestDigest,
    archiveIntegrity: opts.archiveIntegrity,
    trust,
    capabilitiesGranted,
    manifest,
    fsPath: folder,
    installedAt: now,
    updatedAt: now,
  };
  return { ok: true, record, warnings };
}

// Map a SQLite row back into an InstalledPluginRecord. Centralized so every
// reader gets the same JSON parsing contract.
export function rowToInstalledPlugin(row: DbRow): InstalledPluginRecord {
  const manifestJson = typeof row['manifest_json'] === 'string' ? (row['manifest_json'] as string) : '{}';
  const manifest = JSON.parse(manifestJson) as PluginManifest;
  const capabilitiesJson = typeof row['capabilities_granted'] === 'string' ? (row['capabilities_granted'] as string) : '[]';
  const capabilities = JSON.parse(capabilitiesJson) as string[];
  return {
    id:                  String(row['id']),
    title:               String(row['title']),
    version:             String(row['version']),
    sourceKind:          row['source_kind'] as PluginSourceKind,
    source:              String(row['source']),
    pinnedRef:           row['pinned_ref'] != null ? String(row['pinned_ref']) : undefined,
    sourceDigest:        row['source_digest'] != null ? String(row['source_digest']) : undefined,
    sourceMarketplaceId: row['source_marketplace_id'] != null ? String(row['source_marketplace_id']) : undefined,
    sourceMarketplaceEntryName: row['source_marketplace_entry_name'] != null ? String(row['source_marketplace_entry_name']) : undefined,
    sourceMarketplaceEntryVersion: row['source_marketplace_entry_version'] != null ? String(row['source_marketplace_entry_version']) : undefined,
    marketplaceTrust:    row['marketplace_trust'] != null ? row['marketplace_trust'] as MarketplaceTrust : undefined,
    resolvedSource:      row['resolved_source'] != null ? String(row['resolved_source']) : undefined,
    resolvedRef:         row['resolved_ref'] != null ? String(row['resolved_ref']) : undefined,
    manifestDigest:      row['manifest_digest'] != null ? String(row['manifest_digest']) : undefined,
    archiveIntegrity:    row['archive_integrity'] != null ? String(row['archive_integrity']) : undefined,
    trust:               row['trust'] as TrustTier,
    capabilitiesGranted: Array.isArray(capabilities) ? capabilities : [],
    manifest,
    fsPath:              String(row['fs_path']),
    installedAt:         Number(row['installed_at']),
    updatedAt:           Number(row['updated_at']),
  };
}

/**
 * Is this plugin visible from `scope` (the requesting workspace)?
 *
 * Same one-way rule design-systems already ships (`designSystemVisibleFromWorkspace`
 * in design-systems/index.ts): a plugin CLAIMED by another workspace (a
 * `workspace_resources` row whose `workspace_id` differs) is hidden, and an
 * UNCLAIMED plugin (no binding row at all) stays visible everywhere. Every
 * plugin installed before workspace isolation shipped looks unclaimed, so
 * this never makes a pre-existing install vanish out from under an upgrading
 * user — only a plugin installed AFTER this shipped, into a specific
 * workspace, can be hidden from a different one.
 *
 * `scope === undefined` (as opposed to `null` or `''`) is a SEPARATE signal
 * from "no identity": it means the caller — `listInstalledPlugins` called
 * with no second argument at all — never asked for scoping in the first
 * place (id resolution, the bundled-scenario scan), so nothing is filtered
 * regardless of ownership. `null`/`''` means a caller DID ask to be scoped but
 * has no workspace identity to offer (a signed-out client, a `curl` with no
 * headers) — spec 04 §10: that must hide a CLAIMED plugin, not show it, or
 * "no scope" silently becomes "trust everything".
 */
function pluginVisibleFromWorkspace(db: SqliteDb, pluginId: string, scope: string | null | undefined): boolean {
  const binding = getWorkspaceResourceByResourceId(db, 'plugin', pluginId);
  const ownerId = typeof binding?.workspaceId === 'string' ? binding.workspaceId.trim() : '';
  if (binding?.resourceState === 'deleted') return false;
  if (scope === undefined) return true;
  const scopeId = scope?.trim();
  if (!scopeId) return !ownerId;
  if (!ownerId) return true;
  return ownerId === scopeId;
}

/**
 * A materialized Team plugin is readable only while its exact Workspace
 * binding is live. An unbound marker is still accepted for one compatibility
 * read so pre-binding installs can be adopted by the daemon without vanishing
 * during an upgrade; callers must persist that binding immediately.
 */
export function workspaceTeamPluginBindingAllowsRead(
  db: SqliteDb,
  workspaceId: string,
  pluginId: string,
): boolean {
  const binding = getWorkspaceResourceByResourceId(
    db,
    'plugin',
    workspaceTeamPluginBindingResourceId(workspaceId, pluginId),
  );
  if (!binding) return true;
  return binding.workspaceId === workspaceId
    && binding.visibility === 'team'
    && binding.resourceState !== 'deleted';
}

const WORKSPACE_TEAM_PLUGIN_BINDING_PREFIX = 'team-mirror:';

/**
 * Team materializations are separate from the Personal installed-plugin row.
 * The generic binding table only allows one row per resource id, so a Team
 * mirror must not claim the bare plugin id: Personal and Team plugins with the
 * same manifest id are valid and coexist in `listWorkspacePlugins`.
 */
export function workspaceTeamPluginBindingResourceId(
  workspaceId: string,
  pluginId: string,
): string {
  return `${WORKSPACE_TEAM_PLUGIN_BINDING_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(pluginId)}`;
}

export function pluginIdFromWorkspaceTeamPluginBinding(
  workspaceId: string,
  bindingResourceId: string,
): string | null {
  const prefix = `${WORKSPACE_TEAM_PLUGIN_BINDING_PREFIX}${encodeURIComponent(workspaceId)}:`;
  if (!bindingResourceId.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(bindingResourceId.slice(prefix.length));
  } catch {
    return null;
  }
}

export async function resolveWorkspaceTeamPluginWithBindingGate<T>(input: {
  bindingAllowsRead: () => boolean;
  resolve: () => Promise<T | null>;
}): Promise<T | null> {
  if (!input.bindingAllowsRead()) return null;
  const resolved = await input.resolve();
  if (resolved == null || !input.bindingAllowsRead()) return null;
  return resolved;
}

/**
 * `workspaceId` is optional and defaults to the pre-workspace-isolation
 * behavior (every live installed plugin, otherwise unfiltered) so every existing caller —
 * `od plugin list`, inventory stats, the bundled-scenario scan in server.ts —
 * keeps working unchanged, AS LONG AS THEY OMIT THE ARGUMENT ENTIRELY. A
 * reconciled tombstone is terminal even for these unscoped internal callers.
 * `GET /api/plugins` always passes a second argument (`headerValue(...)`,
 * which returns `string | null`, never `undefined`), so it always gets the
 * workspace-scoped view even when the caller has no header — see
 * `pluginVisibleFromWorkspace`'s doc comment for why `undefined` and `null`
 * must NOT collapse to the same "unfiltered" behavior here.
 */
export function listInstalledPlugins(db: SqliteDb, workspaceId?: string | null): InstalledPluginRecord[] {
  const rows = db.prepare(`SELECT * FROM installed_plugins ORDER BY title ASC`).all() as DbRow[];
  const records = rows.map(rowToInstalledPlugin);
  return records.filter((record) => pluginVisibleFromWorkspace(db, record.id, workspaceId));
}

export function getInstalledPlugin(db: SqliteDb, id: string): InstalledPluginRecord | null {
  const row = db.prepare(`SELECT * FROM installed_plugins WHERE id = ?`).get(id) as DbRow | undefined;
  return row ? rowToInstalledPlugin(row) : null;
}

export function upsertInstalledPlugin(db: SqliteDb, record: InstalledPluginRecord): void {
  db.prepare(`
    INSERT INTO installed_plugins (
      id, title, version, source_kind, source, pinned_ref, source_digest,
      source_marketplace_id, source_marketplace_entry_name,
      source_marketplace_entry_version, marketplace_trust, resolved_source,
      resolved_ref, manifest_digest, archive_integrity,
      trust, capabilities_granted, manifest_json,
      fs_path, installed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      version = excluded.version,
      source_kind = excluded.source_kind,
      source = excluded.source,
      pinned_ref = excluded.pinned_ref,
      source_digest = excluded.source_digest,
      source_marketplace_id = excluded.source_marketplace_id,
      source_marketplace_entry_name = excluded.source_marketplace_entry_name,
      source_marketplace_entry_version = excluded.source_marketplace_entry_version,
      marketplace_trust = excluded.marketplace_trust,
      resolved_source = excluded.resolved_source,
      resolved_ref = excluded.resolved_ref,
      manifest_digest = excluded.manifest_digest,
      archive_integrity = excluded.archive_integrity,
      trust = excluded.trust,
      capabilities_granted = excluded.capabilities_granted,
      manifest_json = excluded.manifest_json,
      fs_path = excluded.fs_path,
      updated_at = excluded.updated_at
  `).run(
    record.id,
    record.title,
    record.version,
    record.sourceKind,
    record.source,
    record.pinnedRef ?? null,
    record.sourceDigest ?? null,
    record.sourceMarketplaceId ?? null,
    record.sourceMarketplaceEntryName ?? null,
    record.sourceMarketplaceEntryVersion ?? null,
    record.marketplaceTrust ?? null,
    record.resolvedSource ?? null,
    record.resolvedRef ?? null,
    record.manifestDigest ?? null,
    record.archiveIntegrity ?? null,
    record.trust,
    JSON.stringify(record.capabilitiesGranted ?? []),
    JSON.stringify(record.manifest),
    record.fsPath,
    record.installedAt,
    record.updatedAt,
  );
}

export function deleteInstalledPlugin(db: SqliteDb, id: string): boolean {
  const info = db.prepare(`DELETE FROM installed_plugins WHERE id = ?`).run(id);
  return info.changes > 0;
}
