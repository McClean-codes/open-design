import type { Express, Request, Response } from 'express';

import {
  DesignSystemIntentIdSchema,
  resolveDesignSystemIntentForGeneration,
} from '@open-design/contracts';

import type { ToolTokenGrant } from '../tool-tokens.js';
import {
  readDesignSystemPullFile,
  resolveDesignSystemRuntime,
} from '../design-systems/index.js';

type ProjectRecord = {
  id: string;
  designSystemId?: string | null;
};

type SendApiError = (
  res: Response,
  status: number,
  code: string,
  message: string,
  extras?: Record<string, unknown>,
) => void;

export type RegisterDesignSystemToolRoutesDeps = {
  auth: {
    authorizeToolRequest: (req: Request, res: Response, operation: string) => ToolTokenGrant | null;
  };
  http: {
    sendApiError: SendApiError;
  };
  paths: {
    DESIGN_SYSTEMS_DIR: string;
    USER_DESIGN_SYSTEMS_DIR: string;
  };
  projects: {
    getProject: (id: string) => ProjectRecord | null | undefined;
  };
  runs?: {
    getRun: (id: string) => { designSystemId?: string | null } | null | undefined;
  };
};

export function registerDesignSystemToolRoutes(
  app: Express,
  ctx: RegisterDesignSystemToolRoutesDeps,
): void {
  const { authorizeToolRequest } = ctx.auth;
  const { sendApiError } = ctx.http;

  app.post('/api/tools/design-systems/read', async (req, res) => {
    try {
      const grant = authorizeToolRequest(req, res, 'design-systems:read');
      if (!grant) return;

      const activeDesignSystemId = activeDesignSystemIdForGrant(ctx, grant);
      if (!activeDesignSystemId) {
        return sendApiError(res, 404, 'DESIGN_SYSTEM_NOT_FOUND', 'run or project has no active design system');
      }

      const requestedDesignSystemId = typeof req.body?.designSystemId === 'string'
        ? req.body.designSystemId
        : undefined;
      if (requestedDesignSystemId !== undefined && requestedDesignSystemId !== activeDesignSystemId) {
        return sendApiError(res, 403, 'DESIGN_SYSTEM_DENIED', 'designSystemId is derived from the active tool-token run or project', {
          details: { requestedDesignSystemId, activeDesignSystemId },
        });
      }

      const requestedPath = typeof req.body?.path === 'string' ? req.body.path : '';
      if (!requestedPath) {
        return sendApiError(res, 400, 'INVALID_INPUT', 'path is required');
      }

      const file = await readActiveDesignSystemPullFile(
        ctx.paths.DESIGN_SYSTEMS_DIR,
        ctx.paths.USER_DESIGN_SYSTEMS_DIR,
        activeDesignSystemId,
        requestedPath,
      );
      if (!file) {
        return sendApiError(
          res,
          404,
          'DESIGN_SYSTEM_FILE_NOT_FOUND',
          'design system file was not found or is not declared in manifest.json',
          { details: { path: requestedPath } },
        );
      }

      res.json({ file });
    } catch (error) {
      sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
    }
  });

  app.post('/api/tools/design-systems/resolve-intent', async (req, res) => {
    try {
      const grant = authorizeToolRequest(req, res, 'design-systems:resolve-intent');
      if (!grant) return;

      const activeDesignSystemId = activeDesignSystemIdForGrant(ctx, grant);
      if (!activeDesignSystemId) {
        return sendApiError(res, 404, 'DESIGN_SYSTEM_NOT_FOUND', 'run or project has no active design system');
      }

      const requestedDesignSystemId = typeof req.body?.designSystemId === 'string'
        ? req.body.designSystemId
        : undefined;
      if (requestedDesignSystemId !== undefined && requestedDesignSystemId !== activeDesignSystemId) {
        return sendApiError(res, 403, 'DESIGN_SYSTEM_DENIED', 'designSystemId is derived from the active tool-token run or project', {
          details: { requestedDesignSystemId, activeDesignSystemId },
        });
      }

      const parsedIntent = DesignSystemIntentIdSchema.safeParse(req.body?.intent);
      if (!parsedIntent.success) {
        return sendApiError(res, 400, 'INVALID_INPUT', 'intent must be a canonical design-system intent id');
      }
      const intent = parsedIntent.data;

      const runtime = await resolveDesignSystemRuntime(
        activeDesignSystemId,
        ctx.paths.DESIGN_SYSTEMS_DIR,
        ctx.paths.USER_DESIGN_SYSTEMS_DIR,
      );
      if (runtime.mode === 'legacy') {
        return sendApiError(
          res,
          409,
          'DESIGN_SYSTEM_RUNTIME_UNAVAILABLE',
          'active design system does not declare a structured runtime',
        );
      }
      if (runtime.mode === 'invalid') {
        return sendApiError(
          res,
          422,
          'DESIGN_SYSTEM_RUNTIME_INVALID',
          'active design system declares an invalid structured runtime',
          { details: { errors: runtime.errors } },
        );
      }

      res.json({
        designSystemId: activeDesignSystemId,
        runtime: 'structured',
        resolution: resolveDesignSystemIntentForGeneration(runtime.bundle, intent),
        lint: runtime.bundle.lint,
      });
    } catch (error) {
      sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
    }
  });
}

function activeDesignSystemIdForGrant(
  ctx: RegisterDesignSystemToolRoutesDeps,
  grant: ToolTokenGrant,
): string | null {
  const run = ctx.runs?.getRun(grant.runId);
  if (run !== null && run !== undefined) {
    const runDesignSystemId = run.designSystemId;
    return typeof runDesignSystemId === 'string' && runDesignSystemId.length > 0
      ? runDesignSystemId
      : null;
  }
  const projectDesignSystemId = ctx.projects.getProject(grant.projectId)?.designSystemId;
  return typeof projectDesignSystemId === 'string' && projectDesignSystemId.length > 0
    ? projectDesignSystemId
    : null;
}

async function readActiveDesignSystemPullFile(
  builtInRoot: string,
  userRoot: string,
  designSystemId: string,
  relativePath: string,
) {
  if (designSystemId.startsWith('user:')) {
    return readDesignSystemPullFile(userRoot, designSystemId, relativePath);
  }

  return (
    (await readDesignSystemPullFile(builtInRoot, designSystemId, relativePath))
    ?? (await readDesignSystemPullFile(userRoot, designSystemId, relativePath))
  );
}
