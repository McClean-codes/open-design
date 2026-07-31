import { useEffect, useRef, useState } from 'react';
import type {
  CollabMemberRole,
  CollabPresenceMember,
  ProjectContentTransferState,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { resolveCollabSession } from './collab-session';
import {
  lastResolvedTeamProjects as cachedTeamProjects,
  lastResolvedWorkspaceContext as cachedWorkspaceContext,
} from './useWorkspaceContext';
import { useCollab } from './useCollab';

// Project ids the current viewer created in THIS browser session, tracked at
// module scope like `lastResolvedWorkspaceContext` / `lastResolvedTeamProjects`
// above. `createProject()` (`state/projects.ts`) calls `markProjectCreatedByViewer`
// the instant its create request resolves — before the team catalog or this
// project's own `/collab/status` have had any chance to answer. A project the
// viewer just created cannot possibly be shared yet (sharing is a separate,
// later, explicit action; ownership never transfers), so the very first mount
// of `useProjectCollab` for that id can skip the project-level fail-closed
// window below entirely instead of waiting out `knownUnshared`.
//
// This is the residual case #99's `knownOwnedByViewer` fix did not cover
// (recvpZzWYQrhZQ): #99 relaxes the window once the project is already IN the
// team catalog as owned-by-viewer, but a brand-new project is never in that
// catalog (it was only just created, not shared), so `knownUnshared` stayed
// false — and therefore fail-closed — until the catalog happened to load.
const projectIdsCreatedByViewerThisSession = new Set<string>();

/**
 * Mark `projectId` as created by the current viewer in this browser session.
 * Call this the moment a create request resolves. Idempotent; safe to call
 * more than once for the same id.
 */
export function markProjectCreatedByViewer(projectId: string): void {
  projectIdsCreatedByViewerThisSession.add(projectId);
}

/** Test seam: clear the module-level creation cache between tests. */
export function resetProjectsCreatedByViewerCache(): void {
  projectIdsCreatedByViewerThisSession.clear();
}

/**
 * Whether the project's local file list must be read as "not downloaded yet"
 * rather than "this project is empty". Drives the syncing state that replaces
 * DesignFilesPanel's empty state and its create-a-file CTAs.
 *
 * Invariant: a shared project this daemon has never materialized is ALWAYS
 * download-pending, whatever the status poll has managed to learn about the
 * hub. `awaitingFirstMaterialization` is a purely local daemon fact (it holds
 * only a placeholder record for the project), so it is the one signal
 * available on the very first status response. The other three all need remote
 * enrichment that a fresh install's first response cannot carry, which is why
 * a brand-new member's first open showed an empty project with "create a new
 * sketch" CTAs over content that was still on its way.
 *
 * It also deliberately bypasses `shouldAutoPull` (member-of-a-shared-project).
 * The owner of a placeholder they have not materialized either — the reinstall
 * case, where the daemon self-pulls on their behalf — is looking at the same
 * empty directory, and "these files are not the content" is a fact about the
 * local record, not about who is allowed to pull it.
 */
function localFilesAreNotTheContentYet(signals: {
  awaitingFirstMaterialization: boolean;
  shouldAutoPull: boolean;
  transferring: boolean;
  behindPublishedHead: boolean;
  pullInFlight: boolean;
}): boolean {
  if (signals.awaitingFirstMaterialization) return true;
  return (
    signals.shouldAutoPull
    && (signals.transferring || signals.behindPublishedHead || signals.pullInFlight)
  );
}

export interface UseProjectCollabOptions {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  baseUrl?: string;
  heartbeatMs?: number;
  statusPollMs?: number;
  presenceFilePath?: string | null;
  presenceActivity?: CollabPresenceMember['activity'];
}

interface WorkspaceContextState {
  context: WorkspaceCollabContext | null;
  loading: boolean;
}

function useWorkspaceContextState(options: UseProjectCollabOptions = {}): WorkspaceContextState {
  const baseUrl = options.baseUrl ?? '';
  const fetchImpl = options.fetch;
  // Opening a project used to start this read cold every time, and `viewerOnly`
  // fails closed while it is in flight — so a member's OWN private project
  // opened as a read-only shell: personal avatar in place of the collab roster,
  // disabled 历史版本 / 分享, no composer (acceptance #54, #59). The nav shell has
  // already resolved this exact context and parks it at module scope; seeding
  // from that cache means the window only exists on the very first read of a
  // session, while the request below still revalidates.
  //
  // Only the production path seeds. A test that injects `fetch`/`baseUrl` is
  // pointing at its own daemon, so it must not inherit another suite's context.
  const canSeedFromShell = !fetchImpl && !options.baseUrl;
  const [state, setState] = useState<WorkspaceContextState>(() => {
    const seed = canSeedFromShell ? cachedWorkspaceContext() : null;
    return { context: seed, loading: seed === null };
  });

  useEffect(() => {
    let cancelled = false;
    const run = fetchImpl ?? globalThis.fetch.bind(globalThis);
    void (async () => {
      try {
        const response = await run(`${baseUrl}/api/workspace/context`);
        if (!response.ok) {
          if (!cancelled) setState({ context: null, loading: false });
          return;
        }
        const body = (await response.json()) as { context?: WorkspaceCollabContext | null };
        if (!cancelled) setState({ context: body?.context ?? null, loading: false });
      } catch {
        if (!cancelled) setState({ context: null, loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, fetchImpl]);

  return state;
}

/**
 * Fetch the current workspace context (B-integration seam, GET /api/workspace/
 * context). Null until it loads, or when there is no team-workspace context
 * (personal / signed out / hub unavailable). The daemon serves a dev context
 * until B is wired; production proxies B.
 */
export function useWorkspaceContext(options: UseProjectCollabOptions = {}): WorkspaceCollabContext | null {
  return useWorkspaceContextState(options).context;
}

export interface ProjectCollab {
  /** Whether collab (presence + sync) is active for this project + viewer. */
  enabled: boolean;
  /** The viewer's presence identity, when enabled. */
  member: CollabPresenceMember | null;
  present: CollabPresenceMember[];
  publishedVersion: number | null;
  syncState: ReturnType<typeof useCollab>['syncState'];
  /**
   * Whether the viewer should see this project single-writer/read-only. Two
   * independent gates make it read-only:
   *  1. Workspace-level — the workspace is not writable (`permissions
   *     .canWriteSyncedFiles` is false: locked/frozen billing, or the member was
   *     removed). This freezes EVERYONE, the project owner included.
   *  2. Project-level — the project is shared to the team and the viewer is not
   *     its owner (the member who shared it). Ownership, not workspace role, is
   *     the determinant, so the sharer keeps editing while everyone else views.
   * A personal / unshared project in a writable workspace is never read-only.
   */
  viewerOnly: boolean;
  /**
   * Whether the viewer is this project's OWNER — the member who shared it (its
   * single writer). True only when the polled `ownerMemberId` explicitly matches
   * the current member; it fails closed during the status-load window and for
   * every non-owner. Distinct from `!viewerOnly`, which a workspace-level freeze
   * (locked billing / removed member) can also flip. Drives per-comment
   * permission gates (the owner may delete or send any member's comment) without
   * re-deriving ownership at the call site.
   */
  isOwner: boolean;
  /**
   * Effective project ownership for UX that must not wait on `/collab/status`.
   * True when status confirms the viewer is the single writer **or** the hub
   * catalog already names them as owner (issue #99) **or** this tab created
   * the project this session. Prefer this over raw `isOwner` for sticky defaults
   * (e.g. default chat open/collapsed) that would otherwise latch wrong while
   * `ownerMemberId` is still missing from a shared status payload.
   */
  isEffectiveOwner: boolean;
  /**
   * Confirmed: this is a shared team project the viewer did **not** create.
   * Requires positive evidence of a different owner (status `ownerMemberId`,
   * catalog owner, or a previously confirmed non-owner relationship) — never
   * mere `!isOwner` during the status-unknown window.
   */
  isSharedNonOwner: boolean;
  /**
   * Display name of the member who shared this project (its owner), resolved
   * server-side from the collab-cloud member directory. Drives the "这是 {owner}
   * 创建的共享项目" read-only banner. Null when the project is unshared, off-team,
   * or the owner is not in the directory — the banner then falls back to its
   * name-less copy.
   */
  ownerDisplayName: string | null;
  /** The owner's team role (owner/admin/member); null when unresolved. */
  ownerRole: CollabMemberRole | null;
  /**
   * True only once status has confirmed that a non-owner member's local
   * mirror trails the published head, or while the corresponding pull is
   * active. Status latency by itself is not evidence that local files are
   * stale: reopening an already-materialized project must keep its local
   * files visible while the first status request is in flight.
   */
  downloadPending: boolean;
  reportChange: () => void;
  requestPublish: () => void;
  /** Refresh the presence roster now (hub push-channel consumer). */
  refreshPresence: () => void;
  /** Run one status check now (hub push-channel consumer). */
  checkStatusNow: () => void;
  /** Apply an inbound-transfer lifecycle update from the project SSE. */
  applyContentTransferState?: (state: ProjectContentTransferState) => void;
}

/**
 * Real-product collab integration for a project : resolves the workspace
 * context → decides whether collab runs (team member of a live workspace) → runs
 * presence + sync for the viewer. Dormant (enabled=false, no heartbeat) when the
 * project is personal / the viewer is not a team member — so it is safe to mount
 * unconditionally in the project view.
 */
export function useProjectCollab(
  projectId: string | null | undefined,
  options: UseProjectCollabOptions = {},
): ProjectCollab {
  const { context, loading: workspaceContextLoading } = useWorkspaceContextState(options);
  const decision = resolveCollabSession(context);
  const member = decision.member
    ? {
        ...decision.member,
        ...(options.presenceFilePath ? { filePath: options.presenceFilePath } : {}),
        ...(options.presenceActivity !== undefined ? { activity: options.presenceActivity } : {}),
      }
    : null;
  const collab = useCollab({
    projectId: projectId ?? null,
    member,
    enabled: decision.enabled,
    // Let the status poll (`/collab/status`) start in parallel with
    // `/api/workspace/context` instead of waiting for it — the poll doesn't
    // need `member`/`context` (the daemon resolves the caller's own identity
    // server-side; see useCollab's `statusEnabled` doc). While the context
    // read is still in flight we don't yet know whether collab applies at
    // all, so poll optimistically, same as the surrounding fail-closed UI
    // already assumes "maybe yes" during this exact window (see
    // `relationshipUnknown` below). Once the read resolves, fall back to the
    // real decision: a CONFIRMED permission-denied reason (no-workspace-
    // context / member-removed / lifecycle-xxx — see collab-session.ts) is an
    // identity/permission gate, not a "haven't read the response yet"
    // problem, so it must stop the poll same as before this change.
    statusEnabled: Boolean(projectId) && (workspaceContextLoading || decision.enabled),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
    ...(options.statusPollMs !== undefined ? { statusPollMs: options.statusPollMs } : {}),
  });
  // Gate 1 (workspace-level): a non-writable workspace (locked/frozen billing or
  // a removed member) freezes everyone — consume B's `canWriteSyncedFiles` bit
  // rather than re-deriving from lifecycle so the two lanes cannot drift.
  const workspaceReadOnly = context != null && !context.permissions.canWriteSyncedFiles;
  // Context loading is not the same as confirmed off-team. Fail closed during
  // the initial workspace-context request so an already-pulled shared project
  // never flashes writable controls before B confirms the current member.
  const workspaceContextReadOnly = Boolean(projectId) && workspaceContextLoading;
  // Gate 2 (project-level): a project shared to the team (syncState past
  // `local_only`) is read-only for everyone except the member who shared it — the
  // single writer keeps editing their own project. This fails closed: it stays
  // read-only until the polled owner id EXPLICITLY matches the current member, so
  // a non-owner (of any workspace role — including admin/owner) never gets edit
  // affordances during the load window or when a `/collab/status` payload is
  // briefly missing `ownerMemberId`. The real owner sees a momentary read-only
  // state until their id is confirmed, then flips to editable. A personal /
  // unshared project is never read-only on this gate.
  const statusUnknown = decision.enabled && collab.syncState === null;
  const shared = collab.syncState !== 'local_only' && collab.syncState !== null;
  const collabEnabled = decision.enabled && (statusUnknown || shared);
  const isOwner = collab.ownerMemberId != null && collab.ownerMemberId === context?.workspaceMemberId;
  // A project the hub catalog does not list cannot be shared, so the unknown
  // window does not have to fail closed for it. That window is why a member's
  // OWN fresh private draft flashed the "这是共享项目" read-only banner before
  // `/collab/status` answered (acceptance #27).
  //
  // `null` means the catalog was never read, which is NOT "nothing is shared" —
  // that case keeps failing closed. This only relaxes the UNKNOWN window; once
  // a status arrives, `shared && !isOwner` decides as before.
  const knownCatalog = options.fetch || options.baseUrl ? null : cachedTeamProjects();
  const knownUnshared =
    knownCatalog !== null
    && Boolean(projectId)
    && !knownCatalog.some((entry) => entry.projectId === projectId);
  // The hub catalog records each shared project's `ownerMemberId` — the same id
  // `/collab/status` later confirms as the single writer. When it already names
  // the current member as the owner, the viewer IS the owner regardless of
  // whether the (seconds-long) status poll has answered yet. Trusting it here is
  // what stops an owner's OWN shared project from flashing the "这是共享项目"
  // read-only banner for 1-2s on open, before `ownerMemberId` arrives and
  // `isOwner` flips (issue #99, rec:recvpZwaJNpVai). Same production-only cache
  // the unshared relaxation reads; an injected-fetch test pointing at its own
  // daemon gets `null` and keeps failing closed. Ownership never transfers (the
  // sharer is always the writer), so this catalog fact cannot go stale-wrong.
  const knownOwnedByViewer =
    knownCatalog !== null
    && Boolean(projectId)
    && context?.workspaceMemberId != null
    && knownCatalog.some(
      (entry) => entry.projectId === projectId && entry.ownerMemberId === context.workspaceMemberId,
    );
  // Catalog names a different member as the single writer — usable before
  // `/collab/status` confirms ownerMemberId (mirror of knownOwnedByViewer).
  const knownOwnedBySomeoneElse =
    knownCatalog !== null
    && Boolean(projectId)
    && context?.workspaceMemberId != null
    && knownCatalog.some(
      (entry) =>
        entry.projectId === projectId
        && entry.ownerMemberId != null
        && entry.ownerMemberId !== context.workspaceMemberId,
    );
  // A project this browser tab created moments ago cannot possibly be shared
  // yet — see `projectIdsCreatedByViewerThisSession` above. This covers the
  // window `knownUnshared` cannot: right after creation the project is not
  // (and cannot yet be) in the team catalog at all, so `knownCatalog` loading
  // or not loading is irrelevant here.
  const createdByViewerThisSession =
    Boolean(projectId) && projectIdsCreatedByViewerThisSession.has(projectId as string);
  // Status-confirmed ownership OR catalog/session shortcuts (issue #99 path).
  const isEffectiveOwner = isOwner || knownOwnedByViewer || createdByViewerThisSession;
  // Once `/collab/status` has EXPLICITLY confirmed this project belongs to
  // someone else (shared && !isOwner), remember it for as long as this
  // component stays mounted on this projectId. The owner unsharing later
  // makes `/collab/status` regress to the exact same shape as a project that
  // was NEVER shared (syncState: 'local_only', ownerMemberId: null) —
  // `shared && !isOwner` alone cannot tell those two cases apart, and briefly
  // unlocked full edit access (including sending chat messages) for a member
  // who had just lost read access entirely. A project once confirmed to be
  // someone else's must never look like the viewer's own personal project
  // again, no matter what a later poll reports.
  const confirmedOwnedBySomeoneElseRef = useRef<string | null>(null);
  if (confirmedOwnedBySomeoneElseRef.current !== null && confirmedOwnedBySomeoneElseRef.current !== projectId) {
    confirmedOwnedBySomeoneElseRef.current = null;
  }
  if (shared && !isOwner && projectId) {
    confirmedOwnedBySomeoneElseRef.current = projectId;
  }
  const lostAccessAfterUnshare = confirmedOwnedBySomeoneElseRef.current === projectId && !isOwner;
  // The project-level (single-writer) gate. It defaults to "unknown" rather than
  // "read-only": a viewer the catalog already knows to be the owner, or who
  // created this project in the current session, is never frozen by it, which
  // removes the on-open flash. Everyone else still fails closed through the
  // unknown window, whenever a confirmed status names a different owner, and
  // permanently once this viewer has ever seen this project belong to someone
  // else.
  const sharedReadOnly = knownOwnedByViewer || createdByViewerThisSession
    ? false
    : (statusUnknown && !knownUnshared) || (shared && !isOwner) || lostAccessAfterUnshare;
  const viewerOnly = workspaceContextReadOnly || workspaceReadOnly || sharedReadOnly;
  // Positive non-owner evidence only — sticky UX (default-collapsed chat) must
  // not latch on `shared && !isOwner` while ownerMemberId is still missing from
  // an otherwise-shared status payload for the real owner.
  const statusNamedDifferentOwner =
    collab.ownerMemberId != null
    && context?.workspaceMemberId != null
    && collab.ownerMemberId !== context.workspaceMemberId;
  const isSharedNonOwner =
    !isEffectiveOwner
    && (knownOwnedBySomeoneElse
      || (shared && statusNamedDifferentOwner)
      || lostAccessAfterUnshare);

  // Member content auto-sync (the last link): when a read-only member sees the
  // resource-hub head (`publishedVersion`) advance past what we last pulled,
  // pull the new content into the local project directory. The daemon
  // materializes it and its file watcher then fires the existing live-reload SSE
  // (`useProjectFileEvents` in ProjectView, gated on `daemonLive`), so the
  // FileViewer refreshes on its own — no extra reload wiring is needed here.
  //
  // Only non-owner members of a shared project pull. The owner is the single
  // writer; their local copy is already the newest, and pulling could clobber
  // unpublished edits. A workspace-level read-only freeze also must not make the
  // owner auto-pull over their own working tree, so this gate keys off explicit
  // project ownership instead of the broader `viewerOnly` flag.
  //
  // The cursor seeds from the daemon's durable materializedVersion. A missing
  // cursor fails closed to 0 and pulls; an exact match proves this daemon
  // already has the published head, including across tab remounts/restarts.
  const pullCursorRef = useRef<{ projectId: string | null; version: number }>({
    projectId: null,
    version: 0,
  });
  const pullInFlightRef = useRef(false);
  // Bumped after each successful pull to re-evaluate immediately — this catches
  // a head that advanced while a pull was in flight (the plain publishedVersion
  // dep would otherwise not re-fire once it settles on the newer number).
  const [pullTick, setPullTick] = useState(0);
  const projectKey = projectId ?? null;
  if (pullCursorRef.current.projectId !== projectKey) {
    pullCursorRef.current = {
      projectId: projectKey,
      version: collab.materializedVersion ?? 0,
    };
  } else if (
    collab.materializedVersion != null
    && collab.materializedVersion > pullCursorRef.current.version
  ) {
    // The daemon's durable, owner-scoped cursor is the cold-start truth. Keep
    // the optimistic response cursor below only when it is newer than the
    // latest status response (a pull can finish just before its refresh lands).
    pullCursorRef.current.version = collab.materializedVersion;
  }
  // A pull from the prior project can resolve after navigation. Epoch-gate all
  // async writes so that late completion cannot overwrite the new project's
  // cursor or release its in-flight lock.
  const projectEpochRef = useRef(0);
  useEffect(() => {
    const epoch = projectEpochRef.current + 1;
    projectEpochRef.current = epoch;
    pullInFlightRef.current = false;
    return () => {
      if (projectEpochRef.current === epoch) {
        projectEpochRef.current += 1;
        pullInFlightRef.current = false;
      }
    };
  }, [projectId]);
  const { publishedVersion } = collab;
  const pull = collab.pull;
  const checkStatusNow = collab.checkStatusNow;
  const shouldAutoPull = decision.enabled && shared && !isOwner;
  useEffect(() => {
    if (!shouldAutoPull) return;
    if (publishedVersion == null) return;
    if (publishedVersion <= pullCursorRef.current.version) return;
    if (pullInFlightRef.current) return;
    const epoch = projectEpochRef.current;
    pullInFlightRef.current = true;
    void (async () => {
      let advanced = false;
      try {
        const pulledVersion = await pull();
        if (projectEpochRef.current !== epoch) return;
        // Advance from the daemon's ACTUAL pull response, never from the
        // requested target. A null response cannot prove bytes landed and must
        // remain retryable on the next successful status poll.
        if (pulledVersion != null) {
          pullCursorRef.current.version = Math.max(
            pullCursorRef.current.version,
            pulledVersion,
          );
          advanced = true;
        }
      } catch {
        // Swallow: statusPollGeneration changes on every successful ~5s status
        // response, even when publishedVersion is numerically unchanged, so the
        // next poll retries while the durable/local cursor remains behind.
      } finally {
        if (projectEpochRef.current === epoch) {
          pullInFlightRef.current = false;
        }
      }
      if (advanced && projectEpochRef.current === epoch) {
        setPullTick((n) => n + 1);
        // Re-read the daemon's durable materialization cursor immediately;
        // polling remains the bounded fallback if this refresh fails.
        checkStatusNow();
      }
    })();
  }, [
    shouldAutoPull,
    publishedVersion,
    pull,
    pullTick,
    collab.statusPollGeneration,
    checkStatusNow,
  ]);

  // Status latency alone is not a download: absent a placeholder, only replace
  // local file rows with skeletons after status has confirmed this member
  // should pull and the durable/local cursor is actually behind (or that pull
  // is still active). `pullTick` is not read directly, but its state bump
  // forces this render to observe the ref cursor written by a successful pull.
  const downloadPending = localFilesAreNotTheContentYet({
    awaitingFirstMaterialization: collab.awaitingFirstMaterialization,
    shouldAutoPull,
    transferring: collab.contentTransferState?.status === 'downloading',
    behindPublishedHead:
      publishedVersion != null && publishedVersion > pullCursorRef.current.version,
    pullInFlight: pullInFlightRef.current,
  });

  return {
    enabled: collabEnabled,
    member,
    present: collab.present,
    publishedVersion: collab.publishedVersion,
    syncState: collab.syncState,
    viewerOnly,
    isOwner,
    isEffectiveOwner,
    isSharedNonOwner,
    ownerDisplayName: collab.ownerDisplayName,
    ownerRole: collab.ownerRole,
    downloadPending,
    reportChange: collab.reportChange,
    requestPublish: collab.requestPublish,
    refreshPresence: collab.refreshPresence,
    checkStatusNow: collab.checkStatusNow,
    applyContentTransferState: collab.applyContentTransferState,
  };
}
