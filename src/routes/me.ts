import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { PermissionsService } from '../services/permissions.js';
import { Envelope, ErrorResponse } from '../schemas/envelopes.js';
import { MeDto, MePermissionsDto } from '../schemas/dtos.js';

const PermissionsQuery = z.object({ tenantId: z.string().uuid() });

const TAG = 'me';

// GET /me — basic identity. Requires only `requireAuth`; no service deps.
export const meRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    '/me',
    {
      schema: {
        tags: [TAG],
        summary: "Return the authenticated caller's principal identity",
        response: {
          200: Envelope(MeDto),
          401: ErrorResponse,
        },
      },
      preHandler: app.requireAuth,
    },
    async (req) => ({
      data: {
        principalId: req.principal.id,
        kind: req.principal.kind,
        userId: req.principal.userId,
        apiKeyId: req.principal.apiKeyId,
      },
    }),
  );
};

export interface MePermissionsRoutesDeps {
  permissions: PermissionsService;
}

// GET /me/permissions — effective scopes at a tenant.
export const mePermissionsRoutes = (deps: MePermissionsRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    r.get(
      '/me/permissions',
      {
        schema: {
          tags: [TAG],
          summary: "List the scopes the authenticated caller holds at a tenant",
          querystring: PermissionsQuery,
          response: {
            200: Envelope(MePermissionsDto),
            400: ErrorResponse,
            401: ErrorResponse,
          },
        },
        preHandler: app.requireAuth,
      },
      async (req) => {
        const scopes = await deps.permissions.listScopesForPrincipal(
          req.principal.id,
          req.query.tenantId,
        );
        return {
          data: {
            tenantId: req.query.tenantId,
            scopes: scopes.map((s) => ({
              id: s.id,
              name: s.name,
              description: s.description,
            })),
          },
        };
      },
    );
  };
};
