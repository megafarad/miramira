import { and, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { auditLog, type AuditLogEntry } from '../db/schema.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { paginate } from '../lib/pagination.js';

// The persisted entry shape. All fields except `before` and `after` are
// scalar; before/after are arbitrary JSONB snapshots whose shape is defined
// per-action by the writing service (typically the affected row).
export interface NewAuditEntry {
  actorPrincipalId: string | null;
  actorKind: string | null;
  requestId: string;
  method: string;
  route: string;
  action: string;
  targetType: string;
  targetId: string | null;
  tenantId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Optional narrowing for {@link AuditLogRepo.page}. Every field is AND-ed
 * with the others; an empty filter returns every row.
 */
export interface AuditFilter {
  actorPrincipalId?: string;
  targetType?: string;
  targetId?: string;
  action?: string;
  tenantId?: string;
  requestId?: string;
  /** Inclusive lower bound on createdAt. */
  since?: Date;
  /** Inclusive upper bound on createdAt. */
  until?: Date;
}

export interface AuditLogRepo {
  insert(entry: NewAuditEntry): Promise<AuditLogEntry>;
  findById(id: string): Promise<AuditLogEntry | undefined>;
  /**
   * Paginated read, newest-first. Cursor is the last-seen id; UUIDv7's
   * time-ordering makes `id` a proxy for `created_at` so we don't need a
   * composite cursor. Filters compose with AND.
   */
  page(filter: AuditFilter, opts: PaginationOpts): Promise<PageResult<AuditLogEntry>>;
}

export class AuditLogRepository implements AuditLogRepo {
  constructor(private readonly db: DbOrTx) {}

  async insert(entry: NewAuditEntry): Promise<AuditLogEntry> {
    const [row] = await this.db
      .insert(auditLog)
      .values({
        id: newId(),
        actorPrincipalId: entry.actorPrincipalId,
        actorKind: entry.actorKind,
        requestId: entry.requestId,
        method: entry.method,
        route: entry.route,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        tenantId: entry.tenantId,
        before: entry.before,
        after: entry.after,
        ip: entry.ip,
        userAgent: entry.userAgent,
      })
      .returning();
    if (!row) throw new Error('audit_log insert returned no row');
    return row;
  }

  async findById(id: string): Promise<AuditLogEntry | undefined> {
    const [row] = await this.db.select().from(auditLog).where(eq(auditLog.id, id)).limit(1);
    return row;
  }

  async page(filter: AuditFilter, opts: PaginationOpts): Promise<PageResult<AuditLogEntry>> {
    const where = and(
      ...auditFilterPredicates(filter),
      opts.cursor ? lt(auditLog.id, opts.cursor) : undefined,
    );
    const rows = await this.db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.id))
      .limit(opts.limit + 1);
    return paginate(rows, opts.limit, (r) => r.id);
  }
}

function auditFilterPredicates(filter: AuditFilter): SQL[] {
  const preds: SQL[] = [];
  if (filter.actorPrincipalId !== undefined) {
    preds.push(eq(auditLog.actorPrincipalId, filter.actorPrincipalId));
  }
  if (filter.targetType !== undefined) preds.push(eq(auditLog.targetType, filter.targetType));
  if (filter.targetId !== undefined) preds.push(eq(auditLog.targetId, filter.targetId));
  if (filter.action !== undefined) preds.push(eq(auditLog.action, filter.action));
  if (filter.tenantId !== undefined) preds.push(eq(auditLog.tenantId, filter.tenantId));
  if (filter.requestId !== undefined) preds.push(eq(auditLog.requestId, filter.requestId));
  if (filter.since !== undefined) preds.push(gte(auditLog.createdAt, filter.since));
  if (filter.until !== undefined) preds.push(lte(auditLog.createdAt, filter.until));
  return preds;
}

export type { AuditLogEntry } from '../db/schema.js';
