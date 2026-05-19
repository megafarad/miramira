// Admin-side service for the outbox dead-letter queue.
//
// Wraps OutboxRepository with NotFoundError mapping (so routes can stay
// dumb) and writes an audit_log row inside the same transaction as the
// mutation. Outbox events are system-wide — there is no per-tenant DLQ —
// so the audit `tenantId` is always the master tenant.

import type { Database } from '../db/client.js';
import { OutboxRepository, type DeadFilter, type OutboxEvent } from '../repositories/outbox.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { NotFoundError, ValidationError } from './errors.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { MASTER_TENANT_ID } from '../db/seeds/system-ids.js';

// Hard cap on a single bulk call. Bounds the transaction footprint AND keeps
// an operator typo from wiping the queue with one request. Operators with a
// match set above this must narrow the filter or call repeatedly.
export const BULK_CAP = 500;

/** Selector for a bulk revive / purge: either explicit ids OR a filter. */
export type BulkSelector = { ids: string[] } | { filter: DeadFilter };

export interface BulkResult {
  /** Number of events actually mutated (non-dead ids silently fall out). */
  count: number;
  /** Ids actually mutated, in indeterminate order. */
  ids: string[];
}

export interface OutboxAdminService {
  pageDead(opts: PaginationOpts & DeadFilter): Promise<PageResult<OutboxEvent>>;
  getDead(id: string): Promise<OutboxEvent>;
  revive(id: string, audit?: AuditRequestContext): Promise<OutboxEvent>;
  purge(id: string, audit?: AuditRequestContext): Promise<OutboxEvent>;
  bulkRevive(selector: BulkSelector, audit?: AuditRequestContext): Promise<BulkResult>;
  bulkPurge(selector: BulkSelector, audit?: AuditRequestContext): Promise<BulkResult>;
}

export interface OutboxAdminServiceDeps {
  db: Database;
}

export class OutboxAdminServiceImpl implements OutboxAdminService {
  constructor(private readonly deps: OutboxAdminServiceDeps) {}

  async pageDead(opts: PaginationOpts & DeadFilter): Promise<PageResult<OutboxEvent>> {
    return new OutboxRepository(this.deps.db).pageDead(opts);
  }

  async getDead(id: string): Promise<OutboxEvent> {
    const row = await new OutboxRepository(this.deps.db).getDead(id);
    if (!row) throw new NotFoundError(`dead outbox event ${id} not found`);
    return row;
  }

  async revive(id: string, audit?: AuditRequestContext): Promise<OutboxEvent> {
    return this.deps.db.transaction(async (tx) => {
      const outbox = new OutboxRepository(tx);
      const before = audit ? await outbox.getDead(id) : null;
      const after = await outbox.revive(id);
      if (!after) throw new NotFoundError(`dead outbox event ${id} not found`);
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.outboxRevive,
          targetType: AUDIT_TARGETS.outboxEvent,
          targetId: id,
          tenantId: MASTER_TENANT_ID,
          before,
          after,
        });
      }
      return after;
    });
  }

  async purge(id: string, audit?: AuditRequestContext): Promise<OutboxEvent> {
    return this.deps.db.transaction(async (tx) => {
      const outbox = new OutboxRepository(tx);
      const deleted = await outbox.purge(id);
      if (!deleted) throw new NotFoundError(`dead outbox event ${id} not found`);
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.outboxPurge,
          targetType: AUDIT_TARGETS.outboxEvent,
          targetId: id,
          tenantId: MASTER_TENANT_ID,
          before: deleted,
          after: null,
        });
      }
      return deleted;
    });
  }

  async bulkRevive(selector: BulkSelector, audit?: AuditRequestContext): Promise<BulkResult> {
    return this.deps.db.transaction(async (tx) => {
      const outbox = new OutboxRepository(tx);
      const ids = await resolveSelector(outbox, selector);

      // Snapshot the dead rows before reviving so the audit `before` reflects
      // the pre-revive state. Loaded once into a Map for per-event lookup.
      const before = audit ? await snapshotByIds(outbox, ids) : new Map<string, OutboxEvent>();
      const revived = await outbox.reviveBulk(ids);

      if (audit) {
        const auditLog = new AuditLogRepository(tx);
        for (const row of revived) {
          await auditLog.insert({
            ...audit,
            action: AUDIT_ACTIONS.outboxRevive,
            targetType: AUDIT_TARGETS.outboxEvent,
            targetId: row.id,
            tenantId: MASTER_TENANT_ID,
            before: before.get(row.id) ?? null,
            after: row,
          });
        }
      }
      return { count: revived.length, ids: revived.map((r) => r.id) };
    });
  }

  async bulkPurge(selector: BulkSelector, audit?: AuditRequestContext): Promise<BulkResult> {
    return this.deps.db.transaction(async (tx) => {
      const outbox = new OutboxRepository(tx);
      const ids = await resolveSelector(outbox, selector);
      const deleted = await outbox.purgeBulk(ids);

      if (audit) {
        const auditLog = new AuditLogRepository(tx);
        for (const row of deleted) {
          await auditLog.insert({
            ...audit,
            action: AUDIT_ACTIONS.outboxPurge,
            targetType: AUDIT_TARGETS.outboxEvent,
            targetId: row.id,
            tenantId: MASTER_TENANT_ID,
            before: row,
            after: null,
          });
        }
      }
      return { count: deleted.length, ids: deleted.map((r) => r.id) };
    });
  }
}

// Translate a BulkSelector into a concrete id list, enforcing BULK_CAP.
// Explicit ids are taken at face value (Zod has already validated length);
// filters are counted first so an oversize match returns a clear error
// instead of silently truncating.
async function resolveSelector(
  outbox: OutboxRepository,
  selector: BulkSelector,
): Promise<string[]> {
  if ('ids' in selector) {
    if (selector.ids.length > BULK_CAP) {
      throw new ValidationError(`too many ids: ${selector.ids.length} (max ${BULK_CAP})`);
    }
    return selector.ids;
  }
  const matching = await outbox.countDeadMatching(selector.filter);
  if (matching > BULK_CAP) {
    throw new ValidationError(
      `filter matches ${matching} events; max ${BULK_CAP} per call — narrow the filter`,
    );
  }
  return outbox.findDeadIdsMatching(selector.filter, BULK_CAP);
}

async function snapshotByIds(
  outbox: OutboxRepository,
  ids: string[],
): Promise<Map<string, OutboxEvent>> {
  const snapshot = new Map<string, OutboxEvent>();
  for (const id of ids) {
    const row = await outbox.getDead(id);
    if (row) snapshot.set(id, row);
  }
  return snapshot;
}
