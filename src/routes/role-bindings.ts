import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { RoleBindingsService } from '../services/role-bindings.js';
import type { PermissionsService } from '../services/permissions.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { RoleBindingDto } from '../schemas/dtos.js';

const BindingIdParams = z.object({ id: z.string().uuid() });

const ListQuery = z
  .object({
    tenantId: z.string().uuid(),
    principalId: z.string().uuid().optional(),
    includeRevoked: z.coerce.boolean().optional(),
  })
  .extend(PaginationQuery.shape);

const CreateBindingBody = z.object({
  principalId: z.string().uuid(),
  roleId: z.string().uuid(),
  tenantId: z.string().uuid(),
  expiresAt: z.coerce.date().optional(),
});

const TAG = 'role-bindings';

export interface RoleBindingsRoutesDeps {
  bindings: RoleBindingsService;
  permissions: PermissionsService;
}

export const roleBindingsRoutes = (deps: RoleBindingsRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/role-bindings',
      {
        schema: {
          tags: [TAG],
          summary: 'Grant a role to a principal at a tenant',
          body: CreateBindingBody,
          response: {
            201: Envelope(RoleBindingDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'bindings:manage',
            (req) => (req.body as z.infer<typeof CreateBindingBody>).tenantId,
          ),
        ],
      },
      async (req, reply) => {
        const { principalId, roleId, tenantId, expiresAt } = req.body;
        const binding = await deps.bindings.create(
          {
            principalId,
            roleId,
            tenantId,
            grantedByPrincipalId: req.principal.id,
            expiresAt: expiresAt ?? null,
          },
          req.auditContext(),
        );
        return reply.code(201).send({ data: binding });
      },
    );

    r.delete(
      '/role-bindings/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Revoke a role binding',
          params: BindingIdParams,
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
        const binding = await deps.bindings.get(req.params.id);
        await deps.permissions.assertScope(req.principal.id, binding.tenantId, 'bindings:manage');
        await deps.bindings.revoke(req.params.id, req.auditContext());
        return reply.code(204).send(null);
      },
    );

    r.get(
      '/role-bindings',
      {
        schema: {
          tags: [TAG],
          summary: 'List role bindings at a tenant, optionally filtered by principal',
          querystring: ListQuery,
          response: {
            200: Page(RoleBindingDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'bindings:manage',
            (req) => (req.query as z.infer<typeof ListQuery>).tenantId,
          ),
        ],
      },
      async (req) => {
        const { tenantId, principalId, includeRevoked, limit, cursor } = req.query;
        const { items, nextCursor } = await deps.bindings.page(
          {
            tenantId,
            ...(principalId !== undefined ? { principalId } : {}),
            ...(includeRevoked !== undefined ? { includeRevoked } : {}),
          },
          { limit, ...(cursor !== undefined ? { cursor } : {}) },
        );
        return { data: items, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
      },
    );
  };
};
