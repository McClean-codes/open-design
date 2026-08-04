import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import { coalescedGet } from '../lib/coalesced-get';
import type {
  CollabCloudMemberDirectoryEntry,
  CollabCloudMembersResponse,
  WorkspaceCollabContext,
} from '@open-design/contracts';
import { useWorkspaceContext } from './useWorkspaceContext';
import { useWorkspaceInvalidation } from './workspace-events';
import {
  workspaceIdentityCacheKey,
  workspaceProjectHeaders,
} from './workspace-identity';

// Poll cadence for the collab-cloud member directory. ~15s is light enough to
// keep a comment author's name / role fresh (a member registers on join) without
// a heavy loop; it mirrors `useTeamProjects`'s cadence. The read is daemon-local
// (the daemon caches the directory) so the poll just refetches the whole list.
const TEAM_MEMBERS_POLL_MS = 15_000;
// Poll-as-floor cadence while the workspace SSE is connected.
const TEAM_MEMBERS_SSE_FLOOR_MS = 60_000;

type StoreListener = () => void;

/**
 * One directory snapshot and one poll scheduler for one exact Workspace
 * identity. `useEventStream` already shares the EventSource itself; this store
 * closes the remaining fan-out where every hook subscriber independently
 * reloaded the same roster on mount, push, focus, and its own interval.
 */
class TeamMembersIdentityStore {
  private readonly identity: string;
  private readonly context: WorkspaceCollabContext;
  private readonly listeners = new Set<StoreListener>();
  private readonly consumers = new Set<symbol>();
  private readonly connectedConsumers = new Map<symbol, boolean>();
  private members: CollabCloudMemberDirectoryEntry[] = [];
  private inFlight: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollIntervalMs: number | null = null;
  private requestEpoch = 0;
  private hasSuccessfulLoad = false;
  private disposed = false;

  constructor(identity: string, context: WorkspaceCollabContext) {
    this.identity = identity;
    this.context = context;
  }

  readonly getSnapshot = (): CollabCloudMemberDirectoryEntry[] => this.members;

  readonly subscribe = (listener: StoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retain(consumer: symbol): () => void {
    this.disposed = false;
    this.consumers.add(consumer);
    if (this.consumers.size === 1) {
      void this.load();
      this.rearmPoll();
    } else if (!this.hasSuccessfulLoad) {
      void this.load();
    }
    return () => {
      this.consumers.delete(consumer);
      this.connectedConsumers.delete(consumer);
      if (this.consumers.size === 0) {
        this.dispose();
        if (teamMembersStores.get(this.identity) === this) {
          teamMembersStores.delete(this.identity);
        }
      } else {
        this.rearmPoll();
      }
    };
  }

  setConnected(consumer: symbol, connected: boolean): void {
    if (!this.consumers.has(consumer)) return;
    if (this.connectedConsumers.get(consumer) === connected) return;
    this.connectedConsumers.set(consumer, connected);
    this.rearmPoll();
  }

  readonly load = async (): Promise<void> => {
    if (this.disposed || this.consumers.size === 0) return;
    if (this.inFlight) return this.inFlight;
    const requestEpoch = ++this.requestEpoch;
    const operation = this.performLoad(requestEpoch);
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.inFlight === operation) this.inFlight = null;
    }
  };

  private async performLoad(requestEpoch: number): Promise<void> {
    try {
      const members = await coalescedGet(
        `workspace-members:${this.identity}`,
        async () => {
          const res = await fetch('/api/workspace/members', {
            headers: workspaceProjectHeaders(this.context),
          });
          if (!res.ok) throw new Error(`members ${res.status}`);
          const body = (await res.json()) as CollabCloudMembersResponse;
          return body.members ?? [];
        },
      );
      if (this.disposed || requestEpoch !== this.requestEpoch) return;
      this.hasSuccessfulLoad = true;
      this.members = members;
      for (const listener of Array.from(this.listeners)) listener();
    } catch {
      // A failed refresh is not an authoritative empty directory. Preserve the
      // last-good snapshot; a successful `members: []` above still converges.
    }
  }

  private rearmPoll(): void {
    const nextIntervalMs = Array.from(this.connectedConsumers.values()).some(Boolean)
      ? TEAM_MEMBERS_SSE_FLOOR_MS
      : TEAM_MEMBERS_POLL_MS;
    if (this.pollTimer && this.pollIntervalMs === nextIntervalMs) return;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollIntervalMs = nextIntervalMs;
    this.pollTimer = setInterval(() => {
      if (
        typeof document === 'undefined'
        || document.visibilityState === 'visible'
      ) {
        void this.load();
      }
    }, nextIntervalMs);
  }

  private dispose(): void {
    this.disposed = true;
    this.requestEpoch += 1;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollIntervalMs = null;
    this.connectedConsumers.clear();
  }
}

const teamMembersStores = new Map<string, TeamMembersIdentityStore>();
const EMPTY_MEMBERS: CollabCloudMemberDirectoryEntry[] = [];
const EMPTY_SUBSCRIBE = (): (() => void) => () => {};

function teamMembersStoreFor(
  context: WorkspaceCollabContext | null | undefined,
): TeamMembersIdentityStore | null {
  if (!context) return null;
  const identity = workspaceIdentityCacheKey(context);
  let store = teamMembersStores.get(identity);
  if (!store) {
    store = new TeamMembersIdentityStore(identity, context);
    teamMembersStores.set(identity, store);
  }
  return store;
}

export interface TeamMembersState {
  members: CollabCloudMemberDirectoryEntry[];
  /** memberId → directory entry, for O(1) author/owner resolution. */
  byId: Map<string, CollabCloudMemberDirectoryEntry>;
  /**
   * Turn an opaque `authorMemberId` / `ownerMemberId` into a `{displayName,
   * role}` entry. Resolution order: the roster entry → the CURRENT USER when the
   * id is theirs → null.
   *
   * The current-user arm is an INVARIANT, not an optimization: the signed-in
   * user must always resolve to themselves whether or not a roster exists.
   * `GET /api/workspace/members` answers `{"members":[]}` on a personal
   * workspace, and starts empty on a team workspace during the cold window
   * before the first roster load returns — in both cases the viewer's own
   * comment rendered with no avatar and no name. That fallback lives here so
   * every caller inherits it instead of re-patching each card.
   *
   * Null now means only: no id, or a genuinely unknown OTHER member (off team,
   * or one the daemon has not seen register yet). Callers keep their existing
   * id-only rendering for that case.
   */
  resolve: (memberId: string | null | undefined) => CollabCloudMemberDirectoryEntry | null;
}

/**
 * The signed-in user's own directory entry, synthesized from the workspace
 * context the caller ALREADY holds. Pass it to `useTeamMembers` so the viewer
 * resolves to themselves even when the roster is empty.
 *
 * This deliberately takes an existing `WorkspaceCollabContext` rather than
 * fetching one: `/api/workspace/context` is already read by the nav shell and by
 * every viewer that needs it, and duplicating GETs is what saturated HTTP/1.1's
 * six-connection budget on this branch.
 */
export function currentUserDirectoryEntry(
  context: WorkspaceCollabContext | null | undefined,
): CollabCloudMemberDirectoryEntry | null {
  const memberId = context?.workspaceMemberId?.trim();
  if (!context || !memberId) return null;
  return {
    memberId,
    // Same fallback the daemon uses when it registers an identity into the
    // directory (`collab-cloud-service.ts`): an unnamed identity reads as its
    // id rather than as a blank card.
    displayName: context.displayName?.trim() || memberId,
    role: context.role,
  };
}

/**
 * Collab-cloud member directory read (`GET /api/workspace/members`). Returns the
 * team roster the client uses to render "琼羽 · Owner" on a comment card and the
 * owner name on the shared-project banner. A transient failure preserves the
 * last successful roster for this exact workspace identity; only a successful
 * `members: []` response clears it. Lightly polled so a member who joins
 * mid-session resolves without a refresh.
 *
 * `currentUser` is the viewer's own entry (see {@link currentUserDirectoryEntry}),
 * which `resolve` falls back to so the signed-in user is resolvable with or
 * without a roster. Callers that cannot cheaply supply it may omit it; they then
 * get roster-only resolution, exactly as before.
 */
export function useTeamMembers(
  currentUser?: CollabCloudMemberDirectoryEntry | null,
): TeamMembersState {
  // The identity lives both on the request and in its cache key. When it
  // changes, the hook immediately re-reads that workspace's roster instead of
  // waiting out the 15-60s poll or relying on daemon-global active state.
  //
  // This is not the duplicate GET `currentUserDirectoryEntry` warns about —
  // `useWorkspaceContext` shares one coalesced request and one module-level cache
  // across every mounted consumer, and both call sites of this hook already mount
  // it themselves.
  const {
    context: workspaceContext,
    identityChangePending,
  } = useWorkspaceContext();
  const store = teamMembersStoreFor(workspaceContext);
  const consumerRef = useRef(Symbol('team-members-consumer'));
  const membersSnapshot = useSyncExternalStore(
    store?.subscribe ?? EMPTY_SUBSCRIBE,
    store?.getSnapshot ?? (() => EMPTY_MEMBERS),
    () => EMPTY_MEMBERS,
  );

  useEffect(() => {
    if (!store) return;
    return store.retain(consumerRef.current);
  }, [store]);

  const load = useCallback(() => {
    void store?.load();
  }, [store]);

  // Collab realtime hop-2: subscribe to the workspace SSE and re-fetch on a
  // pushed `members-changed` (someone joined/left/changed role). The daemon's
  // workspace-invalidation poller diffs the roster and pushes only on an actual
  // change. `connected` drives poll-as-floor below.
  const { connected: sseConnected } = useWorkspaceInvalidation(
    { 'members-changed': load },
    {
      workspaceContext,
      onActive: () => void load(),
    },
  );

  useEffect(() => {
    store?.setConnected(consumerRef.current, sseConnected);
  }, [sseConnected, store]);

  const members =
    !identityChangePending && store
      ? membersSnapshot
      : [];
  const byId = useMemo(() => {
    const map = new Map<string, CollabCloudMemberDirectoryEntry>();
    for (const entry of members) map.set(entry.memberId, entry);
    return map;
  }, [members]);

  // Field-wise memo so a caller passing a fresh object literal every render does
  // not churn `resolve`'s identity (and every consumer that depends on it).
  const currentUserMemberId = currentUser?.memberId ?? null;
  const currentUserDisplayName = currentUser?.displayName ?? null;
  const currentUserRole = currentUser?.role ?? null;
  const self = useMemo<CollabCloudMemberDirectoryEntry | null>(
    () =>
      currentUserMemberId && currentUserDisplayName && currentUserRole
        ? {
            memberId: currentUserMemberId,
            displayName: currentUserDisplayName,
            role: currentUserRole,
          }
        : null,
    [
      currentUserMemberId,
      currentUserDisplayName,
      currentUserRole,
    ],
  );

  const resolve = useCallback(
    (memberId: string | null | undefined): CollabCloudMemberDirectoryEntry | null => {
      if (!memberId) return null;
      // The roster wins when it has the member: it is the authoritative name and
      // role, and it stays right when the viewer's own role changes mid-session.
      const entry = byId.get(memberId);
      if (entry) return entry;
      // Me, with no roster (personal workspace) or before it lands.
      if (self && self.memberId === memberId) return self;
      return null;
    },
    [byId, self],
  );

  return { members, byId, resolve };
}
