// Admin-side service for the outbox dead-letter queue.
//
// Wraps OutboxRepository with NotFoundError mapping (so routes can stay
// dumb) and writes an audit_log row inside the same transaction as the
// mutation. Outbox events are system-wide — there is no per-tenant DLQ —
// so the audit `tenantId` is always the master tenant.

import type { Database } from '../db/client.js';
import { OutboxRepository, type OutboxEvent } from '../repositories/outbox.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { NotFoundError } from './errors.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { MASTER_TENANT_ID } from '../db/seeds/system-ids.js';

export interface OutboxAdminService {
  pageDead(opts: PaginationOpts): Promise<PageResult<OutboxEvent>>;
  getDead(id: string): Promise<OutboxEvent>;
  revive(id: string, audit?: AuditRequestContext): Promise<OutboxEvent>;
  purge(id: string, audit?: AuditRequestContext): Promise<OutboxEvent>;
}

export interface OutboxAdminServiceDeps {
  db: Database;
}

export class OutboxAdminServiceImpl implements OutboxAdminService {
  constructor(private readonly deps: OutboxAdminServiceDeps) {}

  async pageDead(opts: PaginationOpts): Promise<PageResult<OutboxEvent>> {
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
}
