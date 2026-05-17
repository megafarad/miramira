import type { Database } from '../db/client.js';
import { TenantsRepository, type CreateTenantInput, type Tenant } from '../repositories/tenants.js';
import { OutboxRepository } from '../repositories/outbox.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { NotFoundError } from './errors.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';
import type { PaginationOpts, PageResult } from '../schemas/envelopes.js';

export interface UpdateTenantInput {
  name?: string;
}

export interface TenantsService {
  create(input: CreateTenantInput, audit?: AuditRequestContext): Promise<Tenant>;
  get(id: string): Promise<Tenant>;
  pageChildren(parentId: string, opts: PaginationOpts): Promise<PageResult<Tenant>>;
  update(id: string, patch: UpdateTenantInput, audit?: AuditRequestContext): Promise<Tenant>;
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

  async update(
    id: string,
    patch: UpdateTenantInput,
    audit?: AuditRequestContext,
  ): Promise<Tenant> {
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
}
