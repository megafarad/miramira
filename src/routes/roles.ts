import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { RolesService } from '../services/roles.js';
import type { PermissionsService } from '../services/permissions.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { RoleDto, RoleWithScopesDto } from '../schemas/dtos.js';

const TenantIdParams = z.object({ tenantId: z.string().uuid() });
const RoleIdParams = z.object({ id: z.string().uuid() });
const RoleScopeParams = z.object({ id: z.string().uuid(), scopeId: z.string().uuid() });

const CreateRoleBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1024).optional(),
  crossesBoundary: z.boolean().optional(),
});

const AddScopesBody = z.object({
  scopeIds: z.array(z.string().uuid()).min(1),
});

const UpdateRoleBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1024).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field required' });

const TAG = 'roles';

export interface RolesRoutesDeps {
  roles: RolesService;
  permissions: PermissionsService;
}

export const rolesRoutes = (deps: RolesRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/tenants/:tenantId/roles',
      {
        schema: {
          tags: [TAG],
          summary: 'Create a role at a tenant',
          params: TenantIdParams,
          body: CreateRoleBody,
          response: {
            200: Envelope(RoleDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            409: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'roles:write',
            (req) => (req.params as { tenantId: string }).tenantId,
          ),
        ],
      },
      async (req) => {
        const { tenantId } = req.params;
        const { name, description, crossesBoundary } = req.body;
        const role = await deps.roles.create(
          {
            tenantId,
            name,
            ...(description !== undefined ? { description } : {}),
            ...(crossesBoundary !== undefined ? { crossesBoundary } : {}),
          },
          req.auditContext(),
        );
        return { data: role };
      },
    );

    r.get(
      '/tenants/:tenantId/roles',
      {
        schema: {
          tags: [TAG],
          summary: 'List roles defined at a tenant',
          params: TenantIdParams,
          querystring: PaginationQuery,
          response: {
            200: Page(RoleDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'roles:read',
            (req) => (req.params as { tenantId: string }).tenantId,
          ),
        ],
      },
      async (req) => {
        const { items, nextCursor } = await deps.roles.pageByTenant(
          req.params.tenantId,
          req.query,
        );
        return { data: items, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
      },
    );

    // Dynamic-tenant routes: resolve the role's tenantId first, then check.
    r.get(
      '/roles/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Get a role with its bundled scopes',
          params: RoleIdParams,
          response: {
            200: Envelope(RoleWithScopesDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: app.requireAuth,
      },
      async (req) => {
        const roleWithScopes = await deps.roles.getWithScopes(req.params.id);
        await deps.permissions.assertScope(
          req.principal.id,
          roleWithScopes.role.tenantId,
          'roles:read',
        );
        return { data: roleWithScopes };
      },
    );

    r.post(
      '/roles/:id/scopes',
      {
        schema: {
          tags: [TAG],
          summary: 'Attach one or more scopes to a role',
          params: RoleIdParams,
          body: AddScopesBody,
          response: {
            200: Envelope(RoleWithScopesDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: app.requireAuth,
      },
      async (req) => {
        const role = await deps.roles.get(req.params.id);
        await deps.permissions.assertScope(req.principal.id, role.tenantId, 'roles:write');
        await deps.roles.addScopes(req.params.id, req.body.scopeIds, req.auditContext());
        const result = await deps.roles.getWithScopes(req.params.id);
        return { data: result };
      },
    );

    r.delete(
      '/roles/:id/scopes/:scopeId',
      {
        schema: {
          tags: [TAG],
          summary: 'Detach a scope from a role',
          params: RoleScopeParams,
          response: {
            204: z.null(),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: app.requireAuth,
      },
      async (req, reply) => {
        const role = await deps.roles.get(req.params.id);
        await deps.permissions.assertScope(req.principal.id, role.tenantId, 'roles:write');
        await deps.roles.removeScope(req.params.id, req.params.scopeId, req.auditContext());
        return reply.code(204).send(null);
      },
    );

    r.patch(
      '/roles/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Rename a role or update its description',
          params: RoleIdParams,
          body: UpdateRoleBody,
          response: {
            200: Envelope(RoleDto),
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
        const existing = await deps.roles.get(req.params.id);
        await deps.permissions.assertScope(req.principal.id, existing.tenantId, 'roles:write');
        const { name, description } = req.body;
        const updated = await deps.roles.update(
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
