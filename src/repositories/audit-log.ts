import type { DbOrTx } from '../db/client.js';
import { newId } from '../lib/ids.js';
import { auditLog, type AuditLogEntry } from '../db/schema.js';

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

export interface AuditLogRepo {
  insert(entry: NewAuditEntry): Promise<AuditLogEntry>;
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
}

export type { AuditLogEntry } from '../db/schema.js';
