import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ScopesService } from '../services/scopes.js';
import type { PermissionsService } from '../services/permissions.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { ScopeDto } from '../schemas/dtos.js';

const TenantIdParams = z.object({ tenantId: z.string().uuid() });
const ScopeIdParams = z.object({ id: z.string().uuid() });

const CreateScopeBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1024).optional(),
});

const UpdateScopeBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1024).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field required' });

const TAG = 'scopes';

export interface ScopesRoutesDeps {
  scopes: ScopesService;
  permissions: PermissionsService;
}

export const scopesRoutes = (deps: ScopesRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/tenants/:tenantId/scopes',
      {
        schema: {
          tags: [TAG],
          summary: 'Define a scope at a tenant',
          params: TenantIdParams,
          body: CreateScopeBody,
          response: {
            200: Envelope(ScopeDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            409: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'scopes:write',
            (req) => (req.params as { tenantId: string }).tenantId,
          ),
        ],
      },
      async (req) => {
        const { tenantId } = req.params;
        const { name, description } = req.body;
        const scope = await deps.scopes.create(
          {
            tenantId,
            name,
            ...(description !== undefined ? { description } : {}),
          },
          req.auditContext(),
        );
        return { data: scope };
      },
    );

    r.get(
      '/tenants/:tenantId/scopes',
      {
        schema: {
          tags: [TAG],
          summary: 'List scopes defined at a tenant',
          params: TenantIdParams,
          querystring: PaginationQuery,
          response: {
            200: Page(ScopeDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'scopes:read',
            (req) => (req.params as { tenantId: string }).tenantId,
          ),
        ],
      },
      async (req) => {
        const { items, nextCursor } = await deps.scopes.pageByTenant(
          req.params.tenantId,
          req.query,
        );
        return { data: items, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
      },
    );

    r.get(
      '/scopes/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Get a scope by id',
          params: ScopeIdParams,
          response: {
            200: Envelope(ScopeDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: app.requireAuth,
      },
      async (req) => {
        const scope = await deps.scopes.get(req.params.id);
        await deps.permissions.assertScope(req.principal.id, scope.tenantId, 'scopes:read');
        return { data: scope };
      },
    );

    r.patch(
      '/scopes/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Rename a scope or update its description',
          params: ScopeIdParams,
          body: UpdateScopeBody,
          response: {
            200: Envelope(ScopeDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
            409: ErrorResponse,
          },
        },
        preHandler: app.requireAuth,
      },
      async (req) => {
        const existing = await deps.scopes.get(req.params.id);
        await deps.permissions.assertScope(req.principal.id, existing.tenantId, 'scopes:write');
        const { name, description } = req.body;
        const updated = await deps.scopes.update(
          req.params.id,
          {
            ...(name !== undefined ? { name } : {}),
            ...(description !== undefined ? { description } : {}),
          },
          req.auditContext(),
        );
        return { data: updated };
      },
    );
  };
};
