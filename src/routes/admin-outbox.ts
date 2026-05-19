// Admin DLQ surface. Lets operators list, inspect, revive, or permanently
// delete dead-letter outbox events without dropping into psql.
//
// Authorization: outbox events aren't tenant-scoped, so every scope check
// resolves to MASTER_TENANT_ID. Read endpoints require `outbox:read`; the
// mutating endpoints require `outbox:write`. Both scopes ship with the
// system `admin` role.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BULK_CAP, type BulkSelector, type OutboxAdminService } from '../services/outbox-admin.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { BulkOutboxResultDto, OutboxEventDto } from '../schemas/dtos.js';
import { MASTER_TENANT_ID } from '../db/seeds/system-ids.js';

const OutboxIdParams = z.object({ id: z.string().uuid() });

// Querystring extension for GET /admin/outbox/dead — same filter shape that
// bulk endpoints accept, so operators can preview a bulk call.
const ListQuery = PaginationQuery.extend({
  eventType: z.string().min(1).optional(),
  deadBefore: z.coerce.date().optional(),
});

// Bulk body: explicit ids OR filter. Both branches use `.strict()` so that
// passing both `ids` AND `filter` is rejected — otherwise Zod's union would
// match the first branch and silently ignore the second key. The `.refine`
// on the filter variant blocks the match-everything payload.
const BulkBody = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(BULK_CAP) }).strict(),
  z
    .object({
      filter: z
        .object({
          eventType: z.string().min(1).optional(),
          deadBefore: z.coerce.date().optional(),
        })
        .refine((f) => f.eventType !== undefined || f.deadBefore !== undefined, {
          message: 'filter must include at least one of eventType or deadBefore',
        }),
    })
    .strict(),
]);

const TAG = 'admin-outbox';

// Outbox is a system-level queue; scope checks always target the master
// tenant. Centralised so all routes use the same resolver.
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
          summary:
            'List dead-letter outbox events (newest first); supports eventType + deadBefore filters',
          querystring: ListQuery,
          response: {
            200: Page(OutboxEventDto),
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('outbox:read', tenantOfRequest)],
      },
      async (req) => {
        const { limit, cursor, eventType, deadBefore } = req.query;
        const { items, nextCursor } = await deps.outboxAdmin.pageDead({
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(eventType !== undefined ? { eventType } : {}),
          ...(deadBefore !== undefined ? { deadBefore } : {}),
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

    r.post(
      '/admin/outbox/dead/revive',
      {
        schema: {
          tags: [TAG],
          summary: `Revive up to ${BULK_CAP} dead events by id list or filter`,
          body: BulkBody,
          response: {
            200: Envelope(BulkOutboxResultDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('outbox:write', tenantOfRequest)],
      },
      async (req) => {
        const result = await deps.outboxAdmin.bulkRevive(
          normalizeSelector(req.body),
          req.auditContext(),
        );
        return { data: result };
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

    r.delete(
      '/admin/outbox/dead',
      {
        schema: {
          tags: [TAG],
          summary: `Permanently delete up to ${BULK_CAP} dead events by id list or filter`,
          body: BulkBody,
          response: {
            200: Envelope(BulkOutboxResultDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('outbox:write', tenantOfRequest)],
      },
      async (req) => {
        const result = await deps.outboxAdmin.bulkPurge(
          normalizeSelector(req.body),
          req.auditContext(),
        );
        return { data: result };
      },
    );
  };
};

// Zod under exactOptionalPropertyTypes infers optional fields as `T | undefined`,
// but DeadFilter declares them as plain `T?`. Strip undefined keys at the
// boundary so the service's BulkSelector type narrows cleanly.
function normalizeSelector(body: z.infer<typeof BulkBody>): BulkSelector {
  if ('ids' in body) return { ids: body.ids };
  const f: { eventType?: string; deadBefore?: Date } = {};
  if (body.filter.eventType !== undefined) f.eventType = body.filter.eventType;
  if (body.filter.deadBefore !== undefined) f.deadBefore = body.filter.deadBefore;
  return { filter: f };
}
