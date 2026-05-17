import type { Database } from '../db/client.js';
import { ApiKeysRepository, type ApiKey } from '../repositories/api-keys.js';
import { PrincipalsRepository } from '../repositories/principals.js';
import { AuditLogRepository } from '../repositories/audit-log.js';
import { NotFoundError } from './errors.js';
import { AUDIT_ACTIONS, AUDIT_TARGETS } from './audit-actions.js';
import type { AuditRequestContext } from '../plugins/audit.js';

export interface CreateApiKeyInput {
  label: string;
  tenantId: string;
  createdByUserId?: string | null;
  expiresAt?: Date | null;
}

export interface CreatedApiKey {
  apiKey: ApiKey;
  principalId: string;
  /** Returned exactly once at creation time. Caller must surface to user. */
  secret: string;
}

export interface ApiKeysService {
  create(input: CreateApiKeyInput, audit?: AuditRequestContext): Promise<CreatedApiKey>;
  get(id: string): Promise<ApiKey>;
  listByTenant(tenantId: string): Promise<ApiKey[]>;
  revoke(id: string, audit?: AuditRequestContext): Promise<ApiKey>;
}

export interface ApiKeysServiceDeps {
  db: Database;
}

export class ApiKeysServiceImpl implements ApiKeysService {
  constructor(private readonly deps: ApiKeysServiceDeps) {}

  // Atomically mint the key + create the principal row so bindings can target
  // it immediately. No outbox event: a key with no bindings grants nothing.
  // Audit `after` stores the api_keys row only — the one-time `secret` is
  // never persisted to the audit table.
  async create(input: CreateApiKeyInput, audit?: AuditRequestContext): Promise<CreatedApiKey> {
    return this.deps.db.transaction(async (tx) => {
      const apiKeys = new ApiKeysRepository(tx);
      const principals = new PrincipalsRepository(tx);

      const { row, secret } = await apiKeys.create(input);
      const principal = await principals.ensureForApiKey(row.id);
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.apiKeyCreate,
          targetType: AUDIT_TARGETS.apiKey,
          targetId: row.id,
          tenantId: row.tenantId,
          before: null,
          after: row,
        });
      }
      return { apiKey: row, principalId: principal.id, secret };
    });
  }

  async get(id: string): Promise<ApiKey> {
    const row = await new ApiKeysRepository(this.deps.db).findById(id);
    if (!row) throw new NotFoundError(`api key ${id} not found`);
    return row;
  }

  async listByTenant(tenantId: string): Promise<ApiKey[]> {
    return new ApiKeysRepository(this.deps.db).listForTenant(tenantId);
  }

  async revoke(id: string, audit?: AuditRequestContext): Promise<ApiKey> {
    return this.deps.db.transaction(async (tx) => {
      const repo = new ApiKeysRepository(tx);
      const before = audit ? await repo.findById(id) : undefined;
      const after = await repo.revoke(id);
      if (!after) throw new NotFoundError(`api key ${id} not found`);
      if (audit) {
        await new AuditLogRepository(tx).insert({
          ...audit,
          action: AUDIT_ACTIONS.apiKeyRevoke,
          targetType: AUDIT_TARGETS.apiKey,
          targetId: id,
          tenantId: after.tenantId,
          before: before ?? null,
          after,
        });
      }
      return after;
    });
  }
}
