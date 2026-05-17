import type { Database } from '../db/client.js';
import type { FgaClient } from '../openfga/client.js';
import { TenantsRepository } from '../repositories/tenants.js';
import { RolesRepository } from '../repositories/roles.js';
import { RoleBindingsRepository } from '../repositories/role-bindings.js';
import { scopeGrantTuple, type TupleKey } from '../openfga/tuples.js';
import { isDuplicateTupleError, isMissingTupleError } from '../openfga/errors.js';

export interface GrantMaterializer {
  materializeBindingCreated(bindingId: string): Promise<void>;
  materializeBindingRevoked(bindingId: string): Promise<void>;
  /**
   * Walk the new tenant's ancestor chain. For each binding at an ancestor
   * whose effective expansion now reaches the new tenant, write the scope_grant
   * tuples for (binding.principal, role.scopes, newTenant).
   */
  materializeTenantCreated(tenantId: string): Promise<void>;
  /**
   * Fan one newly-attached scope across every active binding of the role.
   */
  materializeRoleScopeAdded(roleId: string, scopeId: string): Promise<void>;
  /**
   * Remove one scope's tuples for every active binding of the role, EXCEPT
   * where another (still-active) binding via a different role still grants
   * (principal, scope) at that tenant.
   */
  materializeRoleScopeRemoved(roleId: string, scopeId: string): Promise<void>;
}

export interface GrantMaterializerDeps {
  db: Database;
  fga: FgaClient;
}

export class GrantMaterializerImpl implements GrantMaterializer {
  private readonly tenants: TenantsRepository;
  private readonly roles: RolesRepository;
  private readonly bindings: RoleBindingsRepository;

  constructor(private readonly deps: GrantMaterializerDeps) {
    this.tenants = new TenantsRepository(deps.db);
    this.roles = new RolesRepository(deps.db);
    this.bindings = new RoleBindingsRepository(deps.db);
  }

  async materializeBindingCreated(bindingId: string): Promise<void> {
    const binding = await this.bindings.findById(bindingId);
    if (!binding) return; // binding row vanished — nothing to do
    if (binding.revokedAt) return; // already revoked; revoke event will handle deletes

    const roleWithScopes = await this.roles.getWithScopes(binding.roleId);
    if (!roleWithScopes || roleWithScopes.scopes.length === 0) return;

    const effective = await this.tenants.getEffectiveDescendants(
      binding.tenantId,
      roleWithScopes.role.crossesBoundary,
    );

    for (const tenant of effective) {
      for (const scope of roleWithScopes.scopes) {
        const tuple = scopeGrantTuple({
          principalId: binding.principalId,
          scopeId: scope.id,
          tenantId: tenant.id,
        });
        await this.writeOne(tuple);
      }
    }
  }

  async materializeBindingRevoked(bindingId: string): Promise<void> {
    const binding = await this.bindings.findById(bindingId);
    if (!binding) return;

    const roleWithScopes = await this.roles.getWithScopes(binding.roleId);
    if (!roleWithScopes) return;

    const effective = await this.tenants.getEffectiveDescendants(
      binding.tenantId,
      roleWithScopes.role.crossesBoundary,
    );

    for (const tenant of effective) {
      for (const scope of roleWithScopes.scopes) {
        const stillProvided = await this.isStillProvided(
          binding.principalId,
          tenant.id,
          scope.id,
          bindingId,
        );
        if (stillProvided) continue;

        const tuple = scopeGrantTuple({
          principalId: binding.principalId,
          scopeId: scope.id,
          tenantId: tenant.id,
        });
        await this.deleteOne(tuple);
      }
    }
  }

  // True iff any OTHER active binding grants (principalId, scopeId) at
  // (targetTenantId) — accounting for the other binding's own
  // crosses_boundary + inheritance rules.
  private async isStillProvided(
    principalId: string,
    targetTenantId: string,
    scopeId: string,
    excludeBindingId: string,
  ): Promise<boolean> {
    const candidates = await this.bindings.findOtherActiveBindingsForPrincipalScope(
      principalId,
      scopeId,
      excludeBindingId,
    );
    return this.anyCandidateCovers(candidates, principalId, targetTenantId);
  }

  // Same shape as isStillProvided but without an excludeBindingId. Used after
  // role.scope_removed: the role_scopes row for the modified (role, scope)
  // is already gone, so the join in findActiveBindingsForPrincipalScope
  // naturally excludes bindings of this role.
  private async isStillProvidedAfterScopeRemoval(
    principalId: string,
    targetTenantId: string,
    scopeId: string,
  ): Promise<boolean> {
    const candidates = await this.bindings.findActiveBindingsForPrincipalScope(
      principalId,
      scopeId,
    );
    return this.anyCandidateCovers(candidates, principalId, targetTenantId);
  }

  private async anyCandidateCovers(
    candidates: { roleId: string; tenantId: string }[],
    _principalId: string,
    targetTenantId: string,
  ): Promise<boolean> {
    for (const c of candidates) {
      const role = await this.roles.findById(c.roleId);
      if (!role) continue;
      const eff = await this.tenants.getEffectiveDescendants(c.tenantId, role.crossesBoundary);
      if (eff.some((t) => t.id === targetTenantId)) return true;
    }
    return false;
  }

  async materializeTenantCreated(tenantId: string): Promise<void> {
    const tenant = await this.tenants.get(tenantId);
    if (!tenant) return;
    const ancestors = await this.tenants.getAncestors(tenantId);
    for (const ancestor of ancestors) {
      // A brand-new tenant has no bindings of its own — but iterating its row
      // costs only one cheap query that returns an empty list, so don't bother
      // special-casing.
      const bs = await this.bindings.listForTenant(ancestor.id, { activeOnly: true });
      for (const b of bs) {
        const roleWithScopes = await this.roles.getWithScopes(b.roleId);
        if (!roleWithScopes || roleWithScopes.scopes.length === 0) continue;
        const eff = await this.tenants.getEffectiveDescendants(
          b.tenantId,
          roleWithScopes.role.crossesBoundary,
        );
        if (!eff.some((t) => t.id === tenantId)) continue;
        for (const scope of roleWithScopes.scopes) {
          await this.writeOne(
            scopeGrantTuple({ principalId: b.principalId, scopeId: scope.id, tenantId }),
          );
        }
      }
    }
  }

  async materializeRoleScopeAdded(roleId: string, scopeId: string): Promise<void> {
    const role = await this.roles.findById(roleId);
    if (!role) return;
    const bs = await this.bindings.listForRole(roleId, { activeOnly: true });
    for (const b of bs) {
      const eff = await this.tenants.getEffectiveDescendants(b.tenantId, role.crossesBoundary);
      for (const t of eff) {
        await this.writeOne(
          scopeGrantTuple({ principalId: b.principalId, scopeId, tenantId: t.id }),
        );
      }
    }
  }

  async materializeRoleScopeRemoved(roleId: string, scopeId: string): Promise<void> {
    const role = await this.roles.findById(roleId);
    if (!role) return;
    const bs = await this.bindings.listForRole(roleId, { activeOnly: true });
    for (const b of bs) {
      const eff = await this.tenants.getEffectiveDescendants(b.tenantId, role.crossesBoundary);
      for (const t of eff) {
        if (await this.isStillProvidedAfterScopeRemoval(b.principalId, t.id, scopeId)) continue;
        await this.deleteOne(
          scopeGrantTuple({ principalId: b.principalId, scopeId, tenantId: t.id }),
        );
      }
    }
  }

  private async writeOne(tuple: TupleKey): Promise<void> {
    try {
      await this.deps.fga.writeTuples([tuple]);
    } catch (err) {
      // Tolerate "already exists" — means a concurrent binding wrote it, or
      // this event is a retry after a previous successful write that didn't
      // get acked. The desired end state is the same.
      if (isDuplicateTupleError(err)) return;
      throw err;
    }
  }

  private async deleteOne(tuple: TupleKey): Promise<void> {
    try {
      await this.deps.fga.deleteTuples([tuple]);
    } catch (err) {
      // Tolerate "not found" — same retry-safety semantics.
      if (isMissingTupleError(err)) return;
      throw err;
    }
  }
}
