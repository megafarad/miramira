import type { Database } from '../db/client.js';
import { ScopesRepository, type CreateScopeInput, type Scope } from '../repositories/scopes.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { NotFoundError } from './errors.js';
import { wrapConflict } from './conflict.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';

export interface UpdateScopeInput {
  name?: string;
  description?: string | null;
}

export interface ScopesService {
  create(input: CreateScopeInput, audit?: AuditRequestContext): Promise<Scope>;
  get(id: string): Promise<Scope>;
  pageByTenant(tenantId: string, opts: PaginationOpts): Promise<PageResult<Scope>>;
  update(id: string, patch: UpdateScopeInput, audit?: AuditRequestContext): Promise<Scope>;
}

export interface ScopesServiceDeps {
  db: Database;
}

export class ScopesServiceImpl implements ScopesService {
  constructor(private readonly deps: ScopesServiceDeps) {}

  // No outbox event: a scope is inert until added to a role.
  async create(input: CreateScopeInput, audit?: AuditRequestContext): Promise<Scope> {
    return wrapConflict(
      () =>
        this.deps.db.transaction(async (tx) => {
          const row = await new ScopesRepository(tx).create(input);
          if (audit) {
            await new AuditLogRepository(tx).insert({
              ...audit,
              action: AUDIT_ACTIONS.scopeCreate,
              targetType: AUDIT_TARGETS.scope,
              targetId: row.id,
              tenantId: row.tenantId,
              before: null,
              after: row,
            });
          }
          return row;
        }),
      `scope named "${input.name}" already exists in tenant ${input.tenantId}`,
    );
  }

  async get(id: string): Promise<Scope> {
    const row = await new ScopesRepository(this.deps.db).findById(id);
    if (!row) throw new NotFoundError(`scope ${id} not found`);
    return row;
  }

  async pageByTenant(tenantId: string, opts: PaginationOpts): Promise<PageResult<Scope>> {
    return new ScopesRepository(this.deps.db).pageForTenant(tenantId, opts);
  }

  // Rename + description edit. No outbox event — FGA tuples are keyed by
  // scope ID, not name. After rename, /check with the new name resolves; with
  // the old name returns false (consistent with "unknown scope").
  async update(id: string, patch: UpdateScopeInput, audit?: AuditRequestContext): Promise<Scope> {
    return wrapConflict(
      () =>
        this.deps.db.transaction(async (tx) => {
          const repo = new ScopesRepository(tx);
          const before = audit ? await repo.findById(id) : undefined;
          const after = await repo.update(id, patch);
          if (!after) throw new NotFoundError(`scope ${id} not found`);
          if (audit) {
            await new AuditLogRepository(tx).insert({
              ...audit,
              action: AUDIT_ACTIONS.scopeUpdate,
              targetType: AUDIT_TARGETS.scope,
              targetId: id,
              tenantId: after.tenantId,
              before: before ?? null,
              after,
            });
          }
          return after;
        }),
      `scope named "${patch.name ?? ''}" already exists in this tenant`,
    );
  }
}
