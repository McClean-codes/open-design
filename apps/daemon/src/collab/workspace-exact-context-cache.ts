import type { WorkspaceCollabContext } from '@open-design/contracts';
import type {
  WorkspaceContextProvider,
  WorkspaceContextRequest,
} from './workspace-context.js';

export interface WorkspaceExactContextCacheOptions {
  provider: WorkspaceContextProvider;
  identity(): string;
  realtimeTtlMs?: number;
  now?: () => number;
}

export interface WorkspaceExactContextCache {
  provider: WorkspaceContextProvider;
  refresh(
    request: WorkspaceContextRequest & { workspaceId: string },
  ): Promise<WorkspaceCollabContext | null>;
  cached(workspaceId: string): WorkspaceCollabContext | null;
  setRealtimeHealthy(workspaceId: string, healthy: boolean): void;
  invalidate(workspaceId?: string): void;
}

interface Entry {
  context: WorkspaceCollabContext;
  observedAt: number;
}

const DEFAULT_REALTIME_TTL_MS = 5 * 60_000;

/** Exact-workspace cache for Vela's authenticated `/workspaces/current` read. */
export function createWorkspaceExactContextCache(
  options: WorkspaceExactContextCacheOptions,
): WorkspaceExactContextCache {
  const now = options.now ?? Date.now;
  const realtimeTtlMs = Math.max(1, options.realtimeTtlMs ?? DEFAULT_REALTIME_TTL_MS);
  const entries = new Map<string, Entry>();
  const generations = new Map<string, number>();
  const healthyIdentities = new Map<string, string>();

  const cacheKey = (identity: string, workspaceId: string) =>
    `${identity}\0${workspaceId}`;
  const currentKey = (workspaceId: string) =>
    cacheKey(options.identity(), workspaceId);
  const advanceGeneration = (key: string): number => {
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    return generation;
  };

  const refresh = async (
    request: WorkspaceContextRequest & { workspaceId: string },
  ): Promise<WorkspaceCollabContext | null> => {
    const workspaceId = request.workspaceId.trim();
    if (!workspaceId || !options.provider.resolveExact) return null;
    const key = currentKey(workspaceId);
    if (!generations.has(key)) generations.set(key, 0);
    const generation = generations.get(key) ?? 0;
    const context = await options.provider.resolveExact({
      ...request,
      workspaceId,
    });
    if (
      context &&
      context.workspaceId === workspaceId &&
      (generations.get(key) ?? 0) === generation
    ) {
      entries.set(key, { context, observedAt: now() });
    }
    return context;
  };

  const cached = (workspaceIdInput: string): WorkspaceCollabContext | null => {
    const workspaceId = workspaceIdInput.trim();
    const identity = options.identity();
    if (!workspaceId || healthyIdentities.get(workspaceId) !== identity) return null;
    const key = cacheKey(identity, workspaceId);
    const entry = entries.get(key);
    if (!entry || now() - entry.observedAt >= realtimeTtlMs) return null;
    return entry.context;
  };

  const provider: WorkspaceContextProvider = {
    ...options.provider,
    ...(options.provider.resolveExact
      ? {
          resolveExact: async (
            request: WorkspaceContextRequest & { workspaceId: string },
          ): Promise<WorkspaceCollabContext | null> =>
            cached(request.workspaceId) ?? refresh(request),
        }
      : {}),
  };

  return {
    provider,
    refresh,
    cached,
    setRealtimeHealthy(workspaceIdInput, healthy): void {
      const workspaceId = workspaceIdInput.trim();
      if (!workspaceId) return;
      if (healthy) {
        healthyIdentities.set(workspaceId, options.identity());
        return;
      }
      healthyIdentities.delete(workspaceId);
      const suffix = `\0${workspaceId}`;
      for (const key of generations.keys()) {
        if (!key.endsWith(suffix)) continue;
        advanceGeneration(key);
        entries.delete(key);
      }
    },
    invalidate(workspaceIdInput): void {
      const workspaceId = workspaceIdInput?.trim() ?? '';
      if (workspaceId) {
        healthyIdentities.delete(workspaceId);
        const suffix = `\0${workspaceId}`;
        for (const key of generations.keys()) {
          if (!key.endsWith(suffix)) continue;
          advanceGeneration(key);
          entries.delete(key);
        }
        return;
      }
      healthyIdentities.clear();
      for (const key of generations.keys()) advanceGeneration(key);
      entries.clear();
    },
  };
}
