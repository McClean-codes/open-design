import {
  TeamResourceShareForbiddenError,
  type TeamResourceRequestScope,
  type TeamResourceShareService,
} from '../collab/team-resource-share.js';

export interface PreparedLinkedProjectShare {
  projectId: string;
  /**
   * Move the one backing project projection and its remote Team publication.
   * Implementations must compensate their own partial transition before
   * rejecting; this coordinator compensates the other resource family.
   */
  transition(visibility: 'personal' | 'team'): Promise<void>;
}

export interface CreateLinkedProjectTeamResourceShareServiceOptions {
  resource: TeamResourceShareService;
  /**
   * Resolve and authorize the backing project before either hub is mutated.
   * The returned transition is pinned to this exact Workspace principal.
   */
  prepare(
    resourceId: string,
    scope: TeamResourceRequestScope,
  ): Promise<PreparedLinkedProjectShare>;
}

export interface DesignSystemBackingProjectBinding {
  workspaceId?: string | null;
  createdByWorkspaceMemberId?: string | null;
}

export interface CreateDesignSystemBackingProjectPreparerOptions {
  resolveProjectId(resourceId: string): Promise<string | null> | string | null;
  projectExists(projectId: string): boolean;
  getProjectBinding(projectId: string): DesignSystemBackingProjectBinding | undefined;
  publishProject(
    projectId: string,
    scope: TeamResourceRequestScope,
  ): Promise<{ version: number | null }>;
  unpublishProject(projectId: string, scope: TeamResourceRequestScope): Promise<void>;
  persistVisibility(input: {
    projectId: string;
    scope: TeamResourceRequestScope;
    visibility: 'personal' | 'team';
  }): Promise<void> | void;
  onPrepared?: (input: {
    resourceId: string;
    projectId: string;
    scope: TeamResourceRequestScope;
  }) => void;
}

function compensationError(
  operation: 'share' | 'unshare',
  primary: unknown,
  compensation: unknown,
): Error {
  const error = new Error(
    `linked project ${operation} failed and compensation also failed: ${String(primary)}; ${String(compensation)}`,
  );
  error.name = 'LinkedProjectShareCompensationError';
  (error as Error & { cause?: unknown }).cause = primary;
  return error;
}

/**
 * Build the exact-Workspace project half of the linked-resource saga.
 * Authority is checked before the coordinator publishes the design system,
 * and each remote-project/local-projection pair compensates itself before
 * rejecting.
 */
export function createDesignSystemBackingProjectPreparer(
  options: CreateDesignSystemBackingProjectPreparerOptions,
): CreateLinkedProjectTeamResourceShareServiceOptions['prepare'] {
  return async (resourceId, scope) => {
    const projectId = (await options.resolveProjectId(resourceId))?.trim() ?? '';
    if (!projectId || !options.projectExists(projectId)) {
      throw new Error('design system backing project is unavailable');
    }
    const workspaceId = scope.principal.teamId;
    const memberId = scope.principal.memberId;
    const binding = options.getProjectBinding(projectId);
    if (binding?.workspaceId && binding.workspaceId !== workspaceId) {
      throw new Error('design system backing project belongs to another workspace');
    }
    if (
      binding?.createdByWorkspaceMemberId
      && binding.createdByWorkspaceMemberId !== memberId
    ) {
      throw new TeamResourceShareForbiddenError();
    }
    options.onPrepared?.({ resourceId, projectId, scope });
    return {
      projectId,
      transition: async (visibility) => {
        if (visibility === 'team') {
          const published = await options.publishProject(projectId, scope);
          if (published.version == null) {
            throw new Error('design system backing project publish failed');
          }
          try {
            await options.persistVisibility({ projectId, scope, visibility });
          } catch (error) {
            try {
              await options.unpublishProject(projectId, scope);
            } catch (rollbackError) {
              // Remote rollback failed, so the project publication is still
              // Team-authoritative. Retry the local forward projection once;
              // a transient SQLite failure can converge to the original share
              // intent without asking the outer coordinator to make an unsafe
              // assumption about which project state won.
              try {
                await options.persistVisibility({ projectId, scope, visibility });
                return;
              } catch (forwardError) {
                throw compensationError(
                  'share',
                  error,
                  compensationError('share', rollbackError, forwardError),
                );
              }
            }
            throw error;
          }
          return;
        }
        await options.unpublishProject(projectId, scope);
        try {
          await options.persistVisibility({ projectId, scope, visibility });
        } catch (error) {
          try {
            await options.publishProject(projectId, scope);
          } catch (rollbackError) {
            // The inverse publish failed, so the project remains remotely
            // unshared. Retry the Personal projection once and converge
            // forward before returning control to the resource half.
            try {
              await options.persistVisibility({ projectId, scope, visibility });
              return;
            } catch (forwardError) {
              throw compensationError(
                'unshare',
                error,
                compensationError('unshare', rollbackError, forwardError),
              );
            }
          }
          throw error;
        }
      },
    };
  };
}

/**
 * Couple a Team resource with its editable backing project as a small saga.
 *
 * The Resource Hub has separate design-system and project publications, so no
 * SQL transaction can honestly make the cross-hub write atomic. The ordering
 * here is deliberate and every second-step failure runs the inverse idempotent
 * primitive before the request rejects:
 *
 * - share: publish resource -> move/publish project; compensate by unsharing
 *   the resource if the project transition fails;
 * - unshare: move/unpublish project -> unpublish resource; compensate by
 *   moving/publishing the project back if resource removal fails.
 *
 * `prepare` runs first so a Workspace mismatch or ownership failure cannot
 * leave even the first hub changed. Successful calls do not resolve until both
 * halves agree, which lets the route invalidate both list projections once.
 */
export function createLinkedProjectTeamResourceShareService(
  options: CreateLinkedProjectTeamResourceShareServiceOptions,
): TeamResourceShareService {
  const { resource } = options;
  const service: TeamResourceShareService = {
    configured: resource.configured,
    async share(resourceId, scope) {
      const linkedProject = await options.prepare(resourceId, scope);
      const result = await resource.share(resourceId, scope);
      if (!result) return null;
      try {
        await linkedProject.transition('team');
      } catch (error) {
        try {
          await resource.unshare(resourceId, scope);
        } catch (rollbackError) {
          // The inverse resource write can fail independently. Retry the
          // forward project write once: if that succeeds, the user's original
          // share intent is fully true and no orphan remains despite the
          // failed rollback.
          try {
            await linkedProject.transition('team');
            return result;
          } catch (forwardError) {
            throw compensationError(
              'share',
              error,
              compensationError('share', rollbackError, forwardError),
            );
          }
        }
        throw error;
      }
      return result;
    },
    async unshare(resourceId, scope) {
      // The linked project must not move before the resource's authoritative
      // owner/admin gate has approved this exact caller. `resource.unshare`
      // repeats the same check immediately before its write.
      const sharedResource = (await service.sharedResources(scope))
        .find((candidate) => candidate.id === resourceId);
      if (sharedResource && !sharedResource.canUnshare) {
        throw new TeamResourceShareForbiddenError();
      }
      const linkedProject = await options.prepare(resourceId, scope);
      await linkedProject.transition('personal');
      try {
        return await resource.unshare(resourceId, scope);
      } catch (error) {
        try {
          await linkedProject.transition('team');
        } catch (rollbackError) {
          // Same convergence rule in reverse: when restoring Team also fails,
          // retry the original resource removal once. A success means both
          // halves are Personal and the requested unshare can truthfully
          // complete.
          try {
            return await resource.unshare(resourceId, scope);
          } catch (forwardError) {
            throw compensationError(
              'unshare',
              error,
              compensationError('unshare', rollbackError, forwardError),
            );
          }
        }
        throw error;
      }
    },
    sharedIds: (scope) => resource.sharedIds(scope),
    sharedResources: (scope, readOptions) =>
      resource.sharedResources(scope, readOptions),
    isShared: (resourceId, scope) => resource.isShared(resourceId, scope),
  };
  return service;
}
