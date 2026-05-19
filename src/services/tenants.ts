import type { Database } from '../db/client.js';
import { TenantsRepository, type CreateTenantInput, type Tenant } from '../repositories/tenants.js';
import { OutboxRepository } from '../repositories/outbox.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { ConflictError, NotFoundError } from './errors.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';
import { MASTER_TENANT_ID } from '../db/seeds/system-ids.js';

export interface UpdateTenantInput {
  name?: string;
}

export interface TenantsService {
  create(input: CreateTenantInput, audit?: AuditRequestContext): Promise<Tenant>;
  get(id: string): Promise<Tenant>;
  pageChildren(parentId: string, opts: PaginationOpts): Promise<PageResult<Tenant>>;
  update(id: string, patch: UpdateTenantInput, audit?: AuditRequestContext): Promise<Tenant>;
  /**
   * Hard-delete a tenant. Throws ConflictError listing every blocker that
   * applies (master tenant, child tenants, api_keys in any state, active
   * role_bindings). On success, the FK cascade clears roles/scopes/inactive
   * bindings; no FGA cleanup is needed because the drain rule guarantees
   * no live grants exist.
   */
  delete(id: string, audit?: AuditRequestContext): Promise<void>;
}

export interface TenantsServiceDeps {
  db: Database;
}

export class TenantsServiceImpl implements TenantsService {
  constructor(private readonly deps: TenantsServiceDeps) {}

  async create(input: CreateTenantInput, audit?: AuditRequestContext): Promise<Tenant> {
    return this.deps.db.transaction(async (tx) => {
      const tenants = new TenantsRepository(tx);
      const outbox = new OutboxRepository(tx);

      const row = await tenants.create(input);
      await outbox.enqueue(tx, {
        aggregateType: 'tenant',
        aggregateId: row.id,
        payload: {
          kind: 'tenant.created',
          tenantId: row.id,
          parentId: row.parentId,
        },
      });
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.tenantCreate,
          targetType: AUDIT_TARGETS.tenant,
          targetId: row.id,
          tenantId: row.id,
          before: null,
          after: row,
        });
      }
      return row;
    });
  }

  async get(id: string): Promise<Tenant> {
    const row = await new TenantsRepository(this.deps.db).get(id);
    if (!row) throw new NotFoundError(`tenant ${id} not found`);
    return row;
  }

  async pageChildren(parentId: string, opts: PaginationOpts): Promise<PageResult<Tenant>> {
    const tenants = new TenantsRepository(this.deps.db);
    const parent = await tenants.get(parentId);
    if (!parent) throw new NotFoundError(`tenant ${parentId} not found`);
    return tenants.pageChildren(parentId, opts);
  }

  async update(id: string, patch: UpdateTenantInput, audit?: AuditRequestContext): Promise<Tenant> {
    return this.deps.db.transaction(async (tx) => {
      const repo = new TenantsRepository(tx);
      const before = audit ? await repo.get(id) : undefined;
      const after = await repo.update(id, patch);
      if (!after) throw new NotFoundError(`tenant ${id} not found`);
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.tenantUpdate,
          targetType: AUDIT_TARGETS.tenant,
          targetId: id,
          tenantId: id,
          before: before ?? null,
          after,
        });
      }
      return after;
    });
  }

  async delete(id: string, audit?: AuditRequestContext): Promise<void> {
    await this.deps.db.transaction(async (tx) => {
      const repo = new TenantsRepository(tx);
      const tenant = await repo.get(id);
      if (!tenant) throw new NotFoundError(`tenant ${id} not found`);

      // Run blocker checks inside the same transaction. The master guard is
      // first because it's a structural rule, not a transient state — useful
      // to operators to see it called out distinctly even when other
      // blockers also apply.
      const blockers: string[] = [];
      if (id === MASTER_TENANT_ID) {
        blockers.push('cannot delete the master tenant');
      }
      const [children, keys, bindings] = await Promise.all([
        repo.countChildren(id),
        repo.countApiKeys(id),
        repo.countActiveBindings(id),
      ]);
      if (children > 0) blockers.push(`${children} child tenant(s)`);
      if (keys > 0) blockers.push(`${keys} api_key(s)`);
      if (bindings > 0) blockers.push(`${bindings} active role_binding(s)`);
      if (blockers.length > 0) {
        throw new ConflictError(`cannot delete tenant: ${blockers.join(', ')}`);
      }

      const deleted = await repo.delete(id);
      // The get above means deletion can only fail to a concurrent delete,
      // which we treat as 404 — the row is gone now.
      if (!deleted) throw new NotFoundError(`tenant ${id} not found`);

      if (audit) {
        // tenant_id on audit_log is ON DELETE SET NULL — pinning it to the
        // parent keeps the audit row in a non-null context (master guard
        // above ensures parentId is non-null for any deletable tenant).
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.tenantDelete,
          targetType: AUDIT_TARGETS.tenant,
          targetId: id,
          tenantId: tenant.parentId,
          before: tenant,
          after: null,
        });
      }
    });
  }
}
