// Read-only service for the audit_log table. Audit rows are produced by the
// rest of the system as a side effect of mutating endpoints — this service
// only surfaces them via /admin/audit. Reads are not themselves audited:
// auditing the audit log produces unbounded recursion of operator value.

import type { Database } from '../db/client.js';
import {
  AuditLogRepository,
  type AuditFilter,
  type AuditLogEntry,
} from '../repositories/audit-log.js';
import { NotFoundError } from './errors.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';

export type { AuditFilter } from '../repositories/audit-log.js';

export interface AuditService {
  get(id: string): Promise<AuditLogEntry>;
  page(filter: AuditFilter, opts: PaginationOpts): Promise<PageResult<AuditLogEntry>>;
}

export interface AuditServiceDeps {
  db: Database;
}

export class AuditServiceImpl implements AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  async get(id: string): Promise<AuditLogEntry> {
    const row = await new AuditLogRepository(this.deps.db).findById(id);
    if (!row) throw new NotFoundError(`audit entry ${id} not found`);
    return row;
  }

  async page(filter: AuditFilter, opts: PaginationOpts): Promise<PageResult<AuditLogEntry>> {
    return new AuditLogRepository(this.deps.db).page(filter, opts);
  }
}
