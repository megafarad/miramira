// Admin DLQ surface. Lets operators list, inspect, revive, or permanently
// delete dead-letter outbox events without dropping into psql.
//
// Authorization: outbox events aren't tenant-scoped, so every scope check
// resolves to MASTER_TENANT_ID. Read endpoints require `outbox:read`; the
// two mutating endpoints require `outbox:write`. Both scopes ship with the
// system `admin` role.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OutboxAdminService } from '../services/outbox-admin.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { OutboxEventDto } from '../schemas/dtos.js';
import { MASTER_TENANT_ID } from '../db/seeds/system-ids.js';

const OutboxIdParams = z.object({ id: z.string().uuid() });

const TAG = 'admin-outbox';

// Outbox is a system-level queue; scope checks always target the master
// tenant. Centralised so all four routes use the same resolver.
const tenantOfRequest = (): string => MASTER_TENANT_ID;

export interface AdminOutboxRoutesDeps {
  outboxAdmin: OutboxAdminService;
}

export const adminOutboxRoutes = (deps: AdminOutboxRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/admin/outbox/dead',
      {
        schema: {
          tags: [TAG],
          summary: 'List dead-letter outbox events (newest first)',
          querystring: PaginationQuery,
          response: {
            200: Page(OutboxEventDto),
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('outbox:read', tenantOfRequest)],
      },
      async (req) => {
        const { limit, cursor } = req.query;
        const { items, nextCursor } = await deps.outboxAdmin.pageDead({
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return { data: items, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
      },
    );

    r.get(
      '/admin/outbox/dead/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Get a single dead-letter outbox event with its full payload',
          params: OutboxIdParams,
          response: {
            200: Envelope(OutboxEventDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('outbox:read', tenantOfRequest)],
      },
      async (req) => {
        const event = await deps.outboxAdmin.getDead(req.params.id);
        return { data: event };
      },
    );

    r.post(
      '/admin/outbox/dead/:id/revive',
      {
        schema: {
          tags: [TAG],
          summary:
            'Revive a dead-letter event: clears dead_at, resets attempts, schedules immediate retry',
          params: OutboxIdParams,
          response: {
            200: Envelope(OutboxEventDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('outbox:write', tenantOfRequest)],
      },
      async (req) => {
        const event = await deps.outboxAdmin.revive(req.params.id, req.auditContext());
        return { data: event };
      },
    );

    r.delete(
      '/admin/outbox/dead/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Permanently delete a dead-letter event',
          params: OutboxIdParams,
          response: {
            204: z.null(),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('outbox:write', tenantOfRequest)],
      },
      async (req, reply) => {
        await deps.outboxAdmin.purge(req.params.id, req.auditContext());
        return reply.code(204).send(null);
      },
    );
  };
};
