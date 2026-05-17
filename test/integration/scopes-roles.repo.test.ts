import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { ScopesRepository } from '../../src/repositories/scopes.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import {
  MASTER_TENANT_ID,
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_SCOPE_IDS,
  SYSTEM_SCOPE_NAMES,
} from '../../src/db/seeds/system-ids.js';

describe.skipIf(!(await isDbReachable()))('ScopesRepository + RolesRepository', () => {
  let scopesRepo: ScopesRepository;
  let rolesRepo: RolesRepository;

  beforeAll(() => {
    const { db } = getTestDb();
    scopesRepo = new ScopesRepository(db);
    rolesRepo = new RolesRepository(db);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('master tenant exposes the six seeded system scopes', async () => {
    const list = await scopesRepo.listForTenant(MASTER_TENANT_ID);
    expect(list.map((s) => s.name).sort()).toEqual([...Object.values(SYSTEM_SCOPE_NAMES)].sort());
  });

  it('unique (tenant_id, name) constraint prevents duplicate scope names per tenant', async () => {
    await expect(
      scopesRepo.create({ tenantId: MASTER_TENANT_ID, name: SYSTEM_SCOPE_NAMES.tenantsRead }),
    ).rejects.toThrow();
  });

  it('roles.getWithScopes returns the system admin role with all six system scopes', async () => {
    const adminWithScopes = await rolesRepo.getWithScopes(SYSTEM_ROLE_ADMIN_ID);
    expect(adminWithScopes?.role.name).toBe('admin');
    expect(adminWithScopes?.role.crossesBoundary).toBe(true);
    expect(adminWithScopes?.scopes.map((s) => s.name).sort()).toEqual(
      [...Object.values(SYSTEM_SCOPE_NAMES)].sort(),
    );
  });

  it('addScopes is idempotent and removeScopes detaches', async () => {
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'reader' });
    await rolesRepo.addScopes(role.id, [SYSTEM_SCOPE_IDS.tenantsRead, SYSTEM_SCOPE_IDS.rolesRead]);
    await rolesRepo.addScopes(role.id, [SYSTEM_SCOPE_IDS.tenantsRead]); // duplicate
    let withScopes = await rolesRepo.getWithScopes(role.id);
    expect(withScopes?.scopes).toHaveLength(2);

    await rolesRepo.removeScopes(role.id, [SYSTEM_SCOPE_IDS.tenantsRead]);
    withScopes = await rolesRepo.getWithScopes(role.id);
    expect(withScopes?.scopes.map((s) => s.name)).toEqual([SYSTEM_SCOPE_NAMES.rolesRead]);
  });

  it('cannot create a duplicate role name within a tenant', async () => {
    await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'reader' });
    await expect(
      rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'reader' }),
    ).rejects.toThrow();
  });
});
