import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { TenantsRepository } from '../../src/repositories/tenants.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import { RoleBindingsRepository } from '../../src/repositories/role-bindings.js';
import {
  MASTER_TENANT_ID,
  SYSTEM_ROLE_ADMIN_ID,
} from '../../src/db/seeds/system-ids.js';

describe.skipIf(!(await isDbReachable()))('RoleBindingsRepository', () => {
  let tenants: TenantsRepository;
  let users: UsersRepository;
  let principals: PrincipalsRepository;
  let roles: RolesRepository;
  let bindings: RoleBindingsRepository;

  beforeAll(() => {
    const { db } = getTestDb();
    tenants = new TenantsRepository(db);
    users = new UsersRepository(db);
    principals = new PrincipalsRepository(db);
    roles = new RolesRepository(db);
    bindings = new RoleBindingsRepository(db);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  async function makeUserPrincipal(email: string): Promise<string> {
    const u = await users.upsertByEmailId(email);
    const p = await principals.ensureForUser(u.id);
    return p.id;
  }

  it('creates a binding and lists it for the principal', async () => {
    const principalId = await makeUserPrincipal('alice@example.com');
    await bindings.create({
      principalId,
      roleId: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
    });
    const list = await bindings.listForPrincipal(principalId);
    expect(list).toHaveLength(1);
    expect(list[0]?.roleId).toBe(SYSTEM_ROLE_ADMIN_ID);
  });

  it('unique constraint blocks duplicate (principal, role, tenant)', async () => {
    const principalId = await makeUserPrincipal('bob@example.com');
    await bindings.create({
      principalId,
      roleId: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
    });
    await expect(
      bindings.create({
        principalId,
        roleId: SYSTEM_ROLE_ADMIN_ID,
        tenantId: MASTER_TENANT_ID,
      }),
    ).rejects.toThrow();
  });

  it('revoked bindings are excluded by default but visible with activeOnly:false', async () => {
    const principalId = await makeUserPrincipal('carol@example.com');
    const created = await bindings.create({
      principalId,
      roleId: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
    });
    await bindings.revoke(created.id);
    expect(await bindings.listForPrincipal(principalId)).toHaveLength(0);
    expect(await bindings.listForPrincipal(principalId, { activeOnly: false })).toHaveLength(1);
  });

  it('expired bindings are excluded by default', async () => {
    const principalId = await makeUserPrincipal('dan@example.com');
    await bindings.create({
      principalId,
      roleId: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(await bindings.listForPrincipal(principalId)).toHaveLength(0);
  });

  it('listForTenant returns bindings scoped to the given tenant', async () => {
    const org = await tenants.create({ name: 'org-a', parentId: MASTER_TENANT_ID });
    const tenantRole = await roles.create({ tenantId: org.id, name: 'editor' });
    const pAlice = await makeUserPrincipal('a@example.com');
    const pBob = await makeUserPrincipal('b@example.com');
    await bindings.create({ principalId: pAlice, roleId: tenantRole.id, tenantId: org.id });
    await bindings.create({
      principalId: pBob,
      roleId: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
    });

    const orgBindings = await bindings.listForTenant(org.id);
    expect(orgBindings).toHaveLength(1);
    expect(orgBindings[0]?.principalId).toBe(pAlice);
  });
});
