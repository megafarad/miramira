import type { FgaClient } from '../openfga/client.js';
import type { PrincipalsRepo } from '../repositories/principals.js';
import type { ScopesRepo } from '../repositories/scopes.js';
import type { UsersRepo } from '../repositories/users.js';
import type { Scope } from '../db/schema.js';
import { FGA_RELATIONS, FGA_TYPES } from '../openfga/model.js';
import {
  parseScopeGrantObjectId,
  principalObject,
  scopeGrantObject,
} from '../openfga/tuples.js';
import { ForbiddenError } from './errors.js';

export type SubjectIdentifier =
  | { sub: string }
  | { email: string }
  | { apiKeyId: string };

export interface CheckInput {
  /** The authenticated caller's principal ID. Used for self-checks. */
  requesterPrincipalId: string;
  tenantId: string;
  /** Scope name (e.g., "docs:read"). Resolved against the tenant ancestor chain. */
  scope: string;
  /**
   * When provided, check on behalf of this subject instead of the requester.
   * Callers passing `subject` must hold `permissions:check` at `tenantId`
   * (enforced by the route handler, not here).
   */
  subject?: SubjectIdentifier | undefined;
}

export interface CheckResult {
  allowed: boolean;
}

export interface PermissionsService {
  check(input: CheckInput): Promise<CheckResult>;
  /**
   * Throws {@link ForbiddenError} (→ 403) if `principalId` does not hold
   * `scopeName` at `tenantId`. Used by the authorize plugin's
   * `app.requireScope()` preHandler factory.
   */
  assertScope(principalId: string, tenantId: string, scopeName: string): Promise<void>;
  /**
   * Run multiple checks sequentially; returns results in input order. Callers
   * are responsible for any per-check authz enforcement (e.g., the route
   * handler asserting `permissions:check` when a check carries a subject).
   */
  checkBatch(inputs: CheckInput[]): Promise<CheckResult[]>;
  /**
   * Return the scopes a principal holds at a single tenant, resolved via FGA
   * and decorated with names + descriptions from Postgres. Sorted by name.
   * Empty array if the principal has no grants at this tenant.
   */
  listScopesForPrincipal(principalId: string, tenantId: string): Promise<Scope[]>;
}

export interface PermissionsServiceDeps {
  fga: FgaClient;
  scopes: ScopesRepo;
  principals: PrincipalsRepo;
  users: UsersRepo;
}

export class PermissionsServiceImpl implements PermissionsService {
  constructor(private readonly deps: PermissionsServiceDeps) {}

  async check(input: CheckInput): Promise<CheckResult> {
    const subjectPrincipalId = input.subject
      ? await this.resolveSubject(input.subject)
      : input.requesterPrincipalId;
    // Unknown subject → not allowed. Returning `false` (rather than 404)
    // also avoids leaking which sub/email/apiKeyId values exist.
    if (!subjectPrincipalId) return { allowed: false };

    const scope = await this.deps.scopes.findByNameInAncestors(input.tenantId, input.scope);
    if (!scope) return { allowed: false };

    const allowed = await this.deps.fga.check({
      user: principalObject(subjectPrincipalId),
      relation: FGA_RELATIONS.scopeGranted,
      object: scopeGrantObject(input.tenantId, scope.id),
    });
    return { allowed };
  }

  async assertScope(principalId: string, tenantId: string, scopeName: string): Promise<void> {
    const { allowed } = await this.check({
      requesterPrincipalId: principalId,
      tenantId,
      scope: scopeName,
    });
    if (!allowed) {
      throw new ForbiddenError(`principal lacks ${scopeName} at tenant ${tenantId}`);
    }
  }

  async checkBatch(inputs: CheckInput[]): Promise<CheckResult[]> {
    const results: CheckResult[] = [];
    for (const input of inputs) {
      results.push(await this.check(input));
    }
    return results;
  }

  async listScopesForPrincipal(principalId: string, tenantId: string): Promise<Scope[]> {
    const objects = await this.deps.fga.listObjects({
      user: principalObject(principalId),
      relation: FGA_RELATIONS.scopeGranted,
      type: FGA_TYPES.scopeGrant,
    });

    // FGA returns full "scope_grant:<tenantId>__<scopeId>" strings. Filter to
    // entries at the requested tenant and pull out the scope IDs.
    const typePrefix = `${FGA_TYPES.scopeGrant}:`;
    const scopeIds: string[] = [];
    for (const obj of objects) {
      if (!obj.startsWith(typePrefix)) continue;
      try {
        const parsed = parseScopeGrantObjectId(obj.slice(typePrefix.length));
        if (parsed.tenantId === tenantId) scopeIds.push(parsed.scopeId);
      } catch {
        // Malformed object — skip rather than 500 the whole listing.
      }
    }
    if (scopeIds.length === 0) return [];

    const scopes = await this.deps.scopes.listByIds(scopeIds);
    return scopes.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async resolveSubject(subject: SubjectIdentifier): Promise<string | undefined> {
    if ('sub' in subject) {
      const user = await this.deps.users.findBySupabaseId(subject.sub);
      if (!user) return undefined;
      const principal = await this.deps.principals.findByUserId(user.id);
      return principal?.id;
    }
    if ('email' in subject) {
      const user = await this.deps.users.findByEmail(subject.email);
      if (!user) return undefined;
      const principal = await this.deps.principals.findByUserId(user.id);
      return principal?.id;
    }
    const principal = await this.deps.principals.findByApiKeyId(subject.apiKeyId);
    return principal?.id;
  }
}
