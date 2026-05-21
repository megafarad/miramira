// Admin-side reader for the audit_log table. Lets operators answer "who did
// what when" without dropping into psql.
//
// Authorization: audit rows aren't tenant-scoped (many have null tenant_id),
// so every scope check resolves to MASTER_TENANT_ID. Read-only — there is no
// /admin/audit POST/DELETE because audit rows are produced by the system and
// must never be edited.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { AuditService } from '../services/audit.js';
import type { AuditFilter } from '../repositories/audit-log.js';
import { Envelope, ErrorResponse, Page, PaginationQuery } from '../schemas/envelopes.js';
import { AuditEntryDto } from '../schemas/dtos.js';
import { MASTER_TENANT_ID } from '../db/seeds/system-ids.js';

const AuditIdParams = z.object({ id: z.string().uuid() });

// Querystring extension for GET /admin/audit. Every filter is optional and
// composes with AND; an empty querystring returns every row newest-first.
const ListQuery = PaginationQuery.extend({
  actorPrincipalId: z.string().uuid().optional(),
  targetType: z.string().min(1).optional(),
  targetId: z.string().uuid().optional(),
  action: z.string().min(1).optional(),
  tenantId: z.string().uuid().optional(),
  requestId: z.string().min(1).optional(),
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
});

const TAG = 'admin-audit';

// Audit is a system-level read; scope checks always target the master tenant.
const tenantOfRequest = (): string => MASTER_TENANT_ID;

// Translate Zod's `T | undefined` query fields into an AuditFilter that omits
// undefined keys outright. With `exactOptionalPropertyTypes` set, the optional
// fields refuse to accept `T | undefined`, so we strip the undefineds here at
// the route → service boundary.
function normalizeFilter(q: z.infer<typeof ListQuery>): AuditFilter {
  const f: AuditFilter = {};
  if (q.actorPrincipalId !== undefined) f.actorPrincipalId = q.actorPrincipalId;
  if (q.targetType !== undefined) f.targetType = q.targetType;
  if (q.targetId !== undefined) f.targetId = q.targetId;
  if (q.action !== undefined) f.action = q.action;
  if (q.tenantId !== undefined) f.tenantId = q.tenantId;
  if (q.requestId !== undefined) f.requestId = q.requestId;
  if (q.since !== undefined) f.since = q.since;
  if (q.until !== undefined) f.until = q.until;
  return f;
}

export interface AdminAuditRoutesDeps {
  audit: AuditService;
}

export const adminAuditRoutes = (deps: AdminAuditRoutesDeps): FastifyPluginAsync => {
  return async (app) => {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.get(
      '/admin/audit',
      {
        schema: {
          tags: [TAG],
          summary: 'List audit_log entries (newest first). All filters optional and AND-composed.',
          querystring: ListQuery,
          response: {
            200: Page(AuditEntryDto),
            400: ErrorResponse,
            401: ErrorResponse,
            403: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('audit:read', tenantOfRequest)],
      },
      async (req) => {
        const { limit, cursor } = req.query;
        const { items, nextCursor } = await deps.audit.page(normalizeFilter(req.query), {
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        return { data: items, pageInfo: { nextCursor, hasMore: nextCursor !== null } };
      },
    );

    r.get(
      '/admin/audit/:id',
      {
        schema: {
          tags: [TAG],
          summary: 'Get a single audit_log entry by id',
          params: AuditIdParams,
          response: {
            200: Envelope(AuditEntryDto),
            401: ErrorResponse,
            403: ErrorResponse,
            404: ErrorResponse,
          },
        },
        preHandler: [app.requireAuth, app.requireScope('audit:read', tenantOfRequest)],
      },
      async (req) => {
        const entry = await deps.audit.get(req.params.id);
        return { data: entry };
      },
    );
  };
};
