import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { TenantsService } from '../services/tenants.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { TenantDto } from '../schemas/dtos.js';

const TenantIdParams = z.object({ id: z.string().uuid() });

const CreateTenantBody = z.object({
  name: z.string().min(1).max(255),
  parentId: z.string().uuid(),
  inherit: z.boolean().optional(),
});

const UpdateTenantBody = z
  .object({
    name: z.string().min(1).max(255).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'at least one field required' });

const TAG = 'tenants';

export interface TenantsRoutesDeps {
  tenants: TenantsService;
}

export const tenantsRoutes = (deps: TenantsRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/tenants',
      {
        schema: {
          tags: [TAG],
          summary: 'Create a tenant under a parent',
          body: CreateTenantBody,
          response: {
            200: Envelope(TenantDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'tenants:write',
            (req) => (req.body as z.infer<typeof CreateTenantBody>).parentId,
          ),
        ],
      },
      async (req) => {
        const { name, parentId, inherit } = req.body;
        const tenant = await deps.tenants.create(
          { name, parentId, ...(inherit !== undefined ? { inherit } : {}) },
          req.auditContext(),
        );
        return { data: tenant };
      },
    );

    r.get(
      '/tenants/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Get a tenant by id',
          params: TenantIdParams,
          response: {
            200: Envelope(TenantDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope('tenants:read', (req) => (req.params as { id: string }).id),
        ],
      },
      async (req) => {
        const tenant = await deps.tenants.get(req.params.id);
        return { data: tenant };
      },
    );

    r.get(
      '/tenants/:id/children',
      {
        schema: {
          tags: [TAG],
          summary: 'List immediate children of a tenant',
          params: TenantIdParams,
          querystring: PaginationQuery,
          response: {
            200: Page(TenantDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope('tenants:read', (req) => (req.params as { id: string }).id),
        ],
      },
      async (req) => {
        const { items, nextCursor } = await deps.tenants.pageChildren(req.params.id, req.query);
        return { data: items, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
      },
    );

    r.patch(
      '/tenants/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Rename a tenant',
          params: TenantIdParams,
          body: UpdateTenantBody,
          response: {
            200: Envelope(TenantDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope('tenants:write', (req) => (req.params as { id: string }).id),
        ],
      },
      async (req) => {
        const { name } = req.body;
        const tenant = await deps.tenants.update(
          req.params.id,
          { ...(name !== undefined ? { name } : {}) },
          req.auditContext(),
        );
        return { data: tenant };
      },
    );
  };
};
