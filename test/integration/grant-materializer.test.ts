import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance as _FI } from 'fastify';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { createTestFga, isFgaReachable } from '../_helpers/fga.js';
import type { FgaClient } from '../../src/openfga/client.js';
import { GrantMaterializerImpl } from '../../src/services/grant-materializer.js';
import { TenantsServiceImpl } from '../../src/services/tenants.js';
import { RoleBindingsServiceImpl } from '../../src/services/role-bindings.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import { ScopesRepository } from '../../src/repositories/scopes.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { principalObject, scopeGrantObject } from '../../src/openfga/tuples.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('GrantMaterializer (integration)', () => {
  let fga: FgaClient;
  let cleanupFga: () => Promise<void>;
  let materializer: GrantMaterializerImpl;
  let tenants: TenantsServiceImpl;
  let bindings: RoleBindingsServiceImpl;
  let rolesRepo: RolesRepository;
  let scopesRepo: ScopesRepository;
  let users: UsersRepository;
  let principals: PrincipalsRepository;

  beforeAll(async () => {
    const ctx = await createTestFga();
    fga = ctx.client;
    cleanupFga = ctx.cleanup;
    const { db } = getTestDb();
    materializer = new GrantMaterializerImpl({ db, fga });
    tenants = new TenantsServiceImpl({ db });
    bindings = new RoleBindingsServiceImpl({ db });
    rolesRepo = new RolesRepository(db);
    scopesRepo = new ScopesRepository(db);
    users = new UsersRepository(db);
    principals = new PrincipalsRepository(db);
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await cleanupFga();
    await closeTestDb();
  });

  async function makeUserPrincipal(email: string): Promise<string> {
    const u = await users.upsertByEmailId(email);
    return (await principals.ensureForUser(u.id)).id;
  }

  async function check(principalId: string, tenantId: string, scopeId: string): Promise<boolean> {
    return fga.check({
      user: principalObject(principalId),
      relation: 'granted',
      object: scopeGrantObject(tenantId, scopeId),
    });
  }

  it('case 1: principal at the directly-bound tenant has the scope', async () => {
    const principalId = await makeUserPrincipal('case1@example.com');
    const org = await tenants.create({ name: 'org1', parentId: MASTER_TENANT_ID });
    const scope = await scopesRepo.create({ tenantId: org.id, name: 'docs:read' });
    const role = await rolesRepo.create({ tenantId: org.id, name: 'reader' });
    await rolesRepo.addScopes(role.id, [scope.id]);

    const binding = await bindings.create({
      principalId,
      roleId: role.id,
      tenantId: org.id,
    });
    await materializer.materializeBindingCreated(binding.id);

    expect(await check(principalId, org.id, scope.id)).toBe(true);
  });

  it('case 2: descendant with inherit=true gets the scope', async () => {
    const principalId = await makeUserPrincipal('case2@example.com');
    const parent = await tenants.create({ name: 'p', parentId: MASTER_TENANT_ID });
    const child = await tenants.create({ name: 'c', parentId: parent.id, inherit: true });
    const scope = await scopesRepo.create({ tenantId: parent.id, name: 'docs:read' });
    const role = await rolesRepo.create({ tenantId: parent.id, name: 'reader' });
    await rolesRepo.addScopes(role.id, [scope.id]);

    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: parent.id });
    await materializer.materializeBindingCreated(binding.id);

    expect(await check(principalId, parent.id, scope.id)).toBe(true);
    expect(await check(principalId, child.id, scope.id)).toBe(true);
  });

  it('case 3: descendant with inherit=false, role NOT crossing → no scope', async () => {
    const principalId = await makeUserPrincipal('case3@example.com');
    const parent = await tenants.create({ name: 'p', parentId: MASTER_TENANT_ID });
    const child = await tenants.create({ name: 'c', parentId: parent.id, inherit: false });
    const scope = await scopesRepo.create({ tenantId: parent.id, name: 'docs:read' });
    const role = await rolesRepo.create({
      tenantId: parent.id,
      name: 'reader',
      crossesBoundary: false,
    });
    await rolesRepo.addScopes(role.id, [scope.id]);

    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: parent.id });
    await materializer.materializeBindingCreated(binding.id);

    expect(await check(principalId, parent.id, scope.id)).toBe(true);
    expect(await check(principalId, child.id, scope.id)).toBe(false);
  });

  it('case 4: descendant with inherit=false, role crossing → has scope', async () => {
    const principalId = await makeUserPrincipal('case4@example.com');
    const parent = await tenants.create({ name: 'p', parentId: MASTER_TENANT_ID });
    const child = await tenants.create({ name: 'c', parentId: parent.id, inherit: false });
    const grandchild = await tenants.create({ name: 'g', parentId: child.id, inherit: true });
    const scope = await scopesRepo.create({ tenantId: parent.id, name: 'docs:read' });
    const role = await rolesRepo.create({
      tenantId: parent.id,
      name: 'super-reader',
      crossesBoundary: true,
    });
    await rolesRepo.addScopes(role.id, [scope.id]);

    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: parent.id });
    await materializer.materializeBindingCreated(binding.id);

    expect(await check(principalId, parent.id, scope.id)).toBe(true);
    expect(await check(principalId, child.id, scope.id)).toBe(true);
    expect(await check(principalId, grandchild.id, scope.id)).toBe(true);
  });

  it('case 5: unrelated tenant tree → no scope', async () => {
    const principalId = await makeUserPrincipal('case5@example.com');
    const a = await tenants.create({ name: 'a', parentId: MASTER_TENANT_ID });
    const b = await tenants.create({ name: 'b', parentId: MASTER_TENANT_ID });
    const scope = await scopesRepo.create({ tenantId: a.id, name: 'docs:read' });
    const role = await rolesRepo.create({ tenantId: a.id, name: 'reader' });
    await rolesRepo.addScopes(role.id, [scope.id]);

    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: a.id });
    await materializer.materializeBindingCreated(binding.id);

    expect(await check(principalId, a.id, scope.id)).toBe(true);
    expect(await check(principalId, b.id, scope.id)).toBe(false);
  });

  it('case 6: scope the role does not grant → no access', async () => {
    const principalId = await makeUserPrincipal('case6@example.com');
    const org = await tenants.create({ name: 'org', parentId: MASTER_TENANT_ID });
    const grantedScope = await scopesRepo.create({ tenantId: org.id, name: 'docs:read' });
    const otherScope = await scopesRepo.create({ tenantId: org.id, name: 'docs:write' });
    const role = await rolesRepo.create({ tenantId: org.id, name: 'reader' });
    await rolesRepo.addScopes(role.id, [grantedScope.id]);

    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: org.id });
    await materializer.materializeBindingCreated(binding.id);

    expect(await check(principalId, org.id, grantedScope.id)).toBe(true);
    expect(await check(principalId, org.id, otherScope.id)).toBe(false);
  });

  it('case 7: revoking the binding removes the FGA tuples', async () => {
    const principalId = await makeUserPrincipal('case7@example.com');
    const parent = await tenants.create({ name: 'p', parentId: MASTER_TENANT_ID });
    const child = await tenants.create({ name: 'c', parentId: parent.id, inherit: true });
    const scope = await scopesRepo.create({ tenantId: parent.id, name: 'docs:read' });
    const role = await rolesRepo.create({ tenantId: parent.id, name: 'reader' });
    await rolesRepo.addScopes(role.id, [scope.id]);

    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: parent.id });
    await materializer.materializeBindingCreated(binding.id);
    expect(await check(principalId, child.id, scope.id)).toBe(true);

    await bindings.revoke(binding.id);
    await materializer.materializeBindingRevoked(binding.id);

    expect(await check(principalId, parent.id, scope.id)).toBe(false);
    expect(await check(principalId, child.id, scope.id)).toBe(false);
  });

  it('case 8: two bindings granting same (principal, scope, tenant) — revoke one, tuple persists', async () => {
    const principalId = await makeUserPrincipal('case8@example.com');
    const org = await tenants.create({ name: 'org', parentId: MASTER_TENANT_ID });
    const scope = await scopesRepo.create({ tenantId: org.id, name: 'docs:read' });

    const roleA = await rolesRepo.create({ tenantId: org.id, name: 'role-a' });
    await rolesRepo.addScopes(roleA.id, [scope.id]);
    const roleB = await rolesRepo.create({ tenantId: org.id, name: 'role-b' });
    await rolesRepo.addScopes(roleB.id, [scope.id]);

    const bindingA = await bindings.create({ principalId, roleId: roleA.id, tenantId: org.id });
    const bindingB = await bindings.create({ principalId, roleId: roleB.id, tenantId: org.id });
    await materializer.materializeBindingCreated(bindingA.id);
    await materializer.materializeBindingCreated(bindingB.id);

    expect(await check(principalId, org.id, scope.id)).toBe(true);

    await bindings.revoke(bindingA.id);
    await materializer.materializeBindingRevoked(bindingA.id);

    // Binding B still grants it — the FGA tuple must persist.
    expect(await check(principalId, org.id, scope.id)).toBe(true);

    // Now revoke B too — tuple should disappear.
    await bindings.revoke(bindingB.id);
    await materializer.materializeBindingRevoked(bindingB.id);
    expect(await check(principalId, org.id, scope.id)).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Phase 6: tenant.created fan-out
  // ───────────────────────────────────────────────────────────────────────

  it('tenant.created: new child gains scopes from a pre-existing binding at master (inheritable)', async () => {
    const principalId = await makeUserPrincipal('tc1@example.com');
    const scope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'tc1:read' });
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'tc1-role' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({
      principalId,
      roleId: role.id,
      tenantId: MASTER_TENANT_ID,
    });
    await materializer.materializeBindingCreated(binding.id);

    const newChild = await tenants.create({ name: 'tc1-child', parentId: MASTER_TENANT_ID });
    expect(await check(principalId, newChild.id, scope.id)).toBe(false);

    await materializer.materializeTenantCreated(newChild.id);
    expect(await check(principalId, newChild.id, scope.id)).toBe(true);
  });

  it('tenant.created: new child of inherit=false intermediate is reachable only via crossesBoundary', async () => {
    const principalId = await makeUserPrincipal('tc2@example.com');
    const scope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'tc2:read' });
    const role = await rolesRepo.create({
      tenantId: MASTER_TENANT_ID,
      name: 'tc2-role',
      crossesBoundary: false,
    });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({
      principalId,
      roleId: role.id,
      tenantId: MASTER_TENANT_ID,
    });
    await materializer.materializeBindingCreated(binding.id);

    const blocked = await tenants.create({
      name: 'tc2-blocked',
      parentId: MASTER_TENANT_ID,
      inherit: false,
    });
    await materializer.materializeTenantCreated(blocked.id);
    expect(await check(principalId, blocked.id, scope.id)).toBe(false);

    // Now create a grandchild under the blocked tenant; same expectation.
    const grandchild = await tenants.create({
      name: 'tc2-grandchild',
      parentId: blocked.id,
      inherit: true,
    });
    await materializer.materializeTenantCreated(grandchild.id);
    expect(await check(principalId, grandchild.id, scope.id)).toBe(false);
  });

  it('tenant.created: crossesBoundary binding reaches a new inherit=false descendant', async () => {
    const principalId = await makeUserPrincipal('tc3@example.com');
    const scope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'tc3:read' });
    const role = await rolesRepo.create({
      tenantId: MASTER_TENANT_ID,
      name: 'tc3-role',
      crossesBoundary: true,
    });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({
      principalId,
      roleId: role.id,
      tenantId: MASTER_TENANT_ID,
    });
    await materializer.materializeBindingCreated(binding.id);

    const blocked = await tenants.create({
      name: 'tc3-blocked',
      parentId: MASTER_TENANT_ID,
      inherit: false,
    });
    await materializer.materializeTenantCreated(blocked.id);
    expect(await check(principalId, blocked.id, scope.id)).toBe(true);
  });

  it('tenant.created: sibling subtree unaffected by binding at unrelated branch', async () => {
    const principalId = await makeUserPrincipal('tc4@example.com');
    const left = await tenants.create({ name: 'tc4-left', parentId: MASTER_TENANT_ID });
    const scope = await scopesRepo.create({ tenantId: left.id, name: 'tc4:read' });
    const role = await rolesRepo.create({ tenantId: left.id, name: 'tc4-role' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: left.id });
    await materializer.materializeBindingCreated(binding.id);

    const right = await tenants.create({ name: 'tc4-right', parentId: MASTER_TENANT_ID });
    await materializer.materializeTenantCreated(right.id);
    expect(await check(principalId, right.id, scope.id)).toBe(false);
  });

  it('tenant.created: idempotent when run twice (no duplicate-write errors)', async () => {
    const principalId = await makeUserPrincipal('tc5@example.com');
    const scope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'tc5:read' });
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'tc5-role' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({
      principalId,
      roleId: role.id,
      tenantId: MASTER_TENANT_ID,
    });
    await materializer.materializeBindingCreated(binding.id);

    const child = await tenants.create({ name: 'tc5-child', parentId: MASTER_TENANT_ID });
    await materializer.materializeTenantCreated(child.id);
    await materializer.materializeTenantCreated(child.id); // idempotent
    expect(await check(principalId, child.id, scope.id)).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Phase 6: role.scope_added fan-out
  // ───────────────────────────────────────────────────────────────────────

  it('role.scope_added: new scope fans across every active binding of the role', async () => {
    const principalA = await makeUserPrincipal('rsa-a@example.com');
    const principalB = await makeUserPrincipal('rsa-b@example.com');
    const orgA = await tenants.create({ name: 'rsa-a', parentId: MASTER_TENANT_ID });
    const orgB = await tenants.create({ name: 'rsa-b', parentId: MASTER_TENANT_ID });

    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsa-role' });
    const firstScope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsa:first' });
    await rolesRepo.addScopes(role.id, [firstScope.id]);

    const bindingA = await bindings.create({
      principalId: principalA,
      roleId: role.id,
      tenantId: orgA.id,
    });
    const bindingB = await bindings.create({
      principalId: principalB,
      roleId: role.id,
      tenantId: orgB.id,
    });
    await materializer.materializeBindingCreated(bindingA.id);
    await materializer.materializeBindingCreated(bindingB.id);

    const newScope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsa:new' });
    await rolesRepo.addScopes(role.id, [newScope.id]);
    await materializer.materializeRoleScopeAdded(role.id, newScope.id);

    expect(await check(principalA, orgA.id, newScope.id)).toBe(true);
    expect(await check(principalB, orgB.id, newScope.id)).toBe(true);
    // Sanity: principals don't get each other's tenant grants.
    expect(await check(principalA, orgB.id, newScope.id)).toBe(false);
  });

  it('role.scope_added: role with no bindings → no writes (no error)', async () => {
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsa-empty' });
    const scope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsa-empty:s' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    await expect(
      materializer.materializeRoleScopeAdded(role.id, scope.id),
    ).resolves.toBeUndefined();
  });

  it('role.scope_added: duplicate event is tolerated', async () => {
    const principalId = await makeUserPrincipal('rsa-dup@example.com');
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsa-dup-role' });
    const scope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsa-dup:s' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({
      principalId,
      roleId: role.id,
      tenantId: MASTER_TENANT_ID,
    });
    await materializer.materializeBindingCreated(binding.id);
    // Replay the scope-added event — must not throw on dup.
    await expect(
      materializer.materializeRoleScopeAdded(role.id, scope.id),
    ).resolves.toBeUndefined();
    expect(await check(principalId, MASTER_TENANT_ID, scope.id)).toBe(true);
  });

  // ───────────────────────────────────────────────────────────────────────
  // Phase 6: role.scope_removed fan-out
  // ───────────────────────────────────────────────────────────────────────

  it('role.scope_removed: tuple disappears when no other binding still provides it', async () => {
    const principalId = await makeUserPrincipal('rsr-1@example.com');
    const org = await tenants.create({ name: 'rsr-1-org', parentId: MASTER_TENANT_ID });
    const role = await rolesRepo.create({ tenantId: org.id, name: 'rsr-1-role' });
    const scope = await scopesRepo.create({ tenantId: org.id, name: 'rsr-1:s' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: org.id });
    await materializer.materializeBindingCreated(binding.id);
    expect(await check(principalId, org.id, scope.id)).toBe(true);

    await rolesRepo.removeScopes(role.id, [scope.id]);
    await materializer.materializeRoleScopeRemoved(role.id, scope.id);
    expect(await check(principalId, org.id, scope.id)).toBe(false);
  });

  it('role.scope_removed: tuple persists when ANOTHER role still grants the scope to the principal', async () => {
    const principalId = await makeUserPrincipal('rsr-2@example.com');
    const org = await tenants.create({ name: 'rsr-2-org', parentId: MASTER_TENANT_ID });
    const scope = await scopesRepo.create({ tenantId: org.id, name: 'rsr-2:s' });
    const roleA = await rolesRepo.create({ tenantId: org.id, name: 'rsr-2-a' });
    const roleB = await rolesRepo.create({ tenantId: org.id, name: 'rsr-2-b' });
    await rolesRepo.addScopes(roleA.id, [scope.id]);
    await rolesRepo.addScopes(roleB.id, [scope.id]);
    const bA = await bindings.create({ principalId, roleId: roleA.id, tenantId: org.id });
    const bB = await bindings.create({ principalId, roleId: roleB.id, tenantId: org.id });
    await materializer.materializeBindingCreated(bA.id);
    await materializer.materializeBindingCreated(bB.id);

    // Remove the scope from role A only; role B still grants it.
    await rolesRepo.removeScopes(roleA.id, [scope.id]);
    await materializer.materializeRoleScopeRemoved(roleA.id, scope.id);
    expect(await check(principalId, org.id, scope.id)).toBe(true);

    // Now drop it from B too.
    await rolesRepo.removeScopes(roleB.id, [scope.id]);
    await materializer.materializeRoleScopeRemoved(roleB.id, scope.id);
    expect(await check(principalId, org.id, scope.id)).toBe(false);
  });

  it('role.scope_removed: tolerates missing tuples (already-deleted state)', async () => {
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsr-3-role' });
    const scope = await scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'rsr-3:s' });
    // No bindings exist; calling removed materializer is a no-op and must not throw.
    await expect(
      materializer.materializeRoleScopeRemoved(role.id, scope.id),
    ).resolves.toBeUndefined();
  });
});
