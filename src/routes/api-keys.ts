import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ApiKeysService } from '../services/api-keys.js';
import type { PermissionsService } from '../services/permissions.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { ApiKeyDto, CreatedApiKeyDto } from '../schemas/dtos.js';

const ApiKeyIdParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ tenantId: z.string().uuid() }).extend(PaginationQuery.shape);

const CreateApiKeyBody = z.object({
  label: z.string().min(1).max(255),
  tenantId: z.string().uuid(),
  expiresAt: z.coerce.date().optional(),
});

const TAG = 'api-keys';

export interface ApiKeysRoutesDeps {
  apiKeys: ApiKeysService;
  permissions: PermissionsService;
}

export const apiKeysRoutes = (deps: ApiKeysRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      '/api-keys',
      {
        schema: {
          tags: [TAG],
          summary: 'Mint a new API key (secret returned exactly once)',
          body: CreateApiKeyBody,
          response: {
            201: Envelope(CreatedApiKeyDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'api_keys:manage',
            (req) => (req.body as z.infer<typeof CreateApiKeyBody>).tenantId,
          ),
        ],
      },
      async (req, reply) => {
        const { label, tenantId, expiresAt } = req.body;
        const createdByUserId = req.principal.kind === 'user' ? req.principal.userId : null;
        const created = await deps.apiKeys.create(
          {
            label,
            tenantId,
            createdByUserId,
            expiresAt: expiresAt ?? null,
          },
          req.auditContext(),
        );
        return reply.code(201).send({
          data: {
            id: created.apiKey.id,
            label: created.apiKey.label,
            tenantId: created.apiKey.tenantId,
            principalId: created.principalId,
            keyPrefix: created.apiKey.keyPrefix,
            expiresAt: created.apiKey.expiresAt,
            createdAt: created.apiKey.createdAt,
            secret: created.secret,
          },
        });
      },
    );

    r.get(
      '/api-keys',
      {
        schema: {
          tags: [TAG],
          summary: 'List API keys at a tenant (secrets and hashes never returned)',
          querystring: ListQuery,
          response: {
            200: Page(ApiKeyDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [
          app.requireAuth,
          app.requireScope(
            'api_keys:manage',
            (req) => (req.query as z.infer<typeof ListQuery>).tenantId,
          ),
        ],
      },
      async (req) => {
        const { tenantId, limit, cursor } = req.query;
        const { items, nextCursor } = await deps.apiKeys.pageByTenant(tenantId, {
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return {
          data: items.map((k) => ({
            id: k.id,
            label: k.label,
            tenantId: k.tenantId,
            keyPrefix: k.keyPrefix,
            createdByUserId: k.createdByUserId,
            lastUsedAt: k.lastUsedAt,
            expiresAt: k.expiresAt,
            revokedAt: k.revokedAt,
            createdAt: k.createdAt,
          })),
          pageInfo: { nextCursor, hasMore: nextCursor !== null },
        };
      },
    );

    r.delete(
      '/api-keys/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Revoke an API key (the key cannot authenticate after this)',
          params: ApiKeyIdParams,
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
        const key = await deps.apiKeys.get(req.params.id);
        await deps.permissions.assertScope(req.principal.id, key.tenantId, 'api_keys:manage');
        await deps.apiKeys.revoke(req.params.id, req.auditContext());
        return reply.code(204).send(null);
      },
    );
  };
};
