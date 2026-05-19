import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { TenantsRepository } from '../../src/repositories/tenants.js';
import { ApiKeysRepository } from '../../src/repositories/api-keys.js';
import { RoleBindingsRepository } from '../../src/repositories/role-bindings.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

describe.skipIf(!(await isDbReachable()))('TenantsRepository', () => {
  let repo: TenantsRepository;

  beforeAll(() => {
    const { db } = getTestDb();
    repo = new TenantsRepository(db);
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('creates a tenant under master and reads it back', async () => {
    const created = await repo.create({ name: 'org-a', parentId: MASTER_TENANT_ID });
    expect(created.name).toBe('org-a');
    expect(created.parentId).toBe(MASTER_TENANT_ID);
    expect(created.inherit).toBe(true);

    const fetched = await repo.get(created.id);
    expect(fetched?.id).toBe(created.id);
  });

  it('returns master alone for getAncestors(master)', async () => {
    const chain = await repo.getAncestors(MASTER_TENANT_ID);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.id).toBe(MASTER_TENANT_ID);
    expect(chain[0]?.parentId).toBeNull();
  });

  it('returns the full chain root-first for a three-deep hierarchy', async () => {
    const a = await repo.create({ name: 'A', parentId: MASTER_TENANT_ID });
    const b = await repo.create({ name: 'B', parentId: a.id });
    const c = await repo.create({ name: 'C', parentId: b.id });

    const chain = await repo.getAncestors(c.id);
    expect(chain.map((t) => t.name)).toEqual(['master', 'A', 'B', 'C']);
  });

  it('still walks past a tenant marked inherit=false (the walk is structural; service layer decides on inheritance)', async () => {
    const a = await repo.create({ name: 'A', parentId: MASTER_TENANT_ID, inherit: false });
    const b = await repo.create({ name: 'B', parentId: a.id });

    const chain = await repo.getAncestors(b.id);
    expect(chain.map((t) => t.name)).toEqual(['master', 'A', 'B']);
    expect(chain.find((t) => t.name === 'A')?.inherit).toBe(false);
  });

  it('listChildren returns direct children only', async () => {
    const a = await repo.create({ name: 'A', parentId: MASTER_TENANT_ID });
    await repo.create({ name: 'A.1', parentId: a.id });
    await repo.create({ name: 'A.2', parentId: a.id });

    const masterChildren = await repo.listChildren(MASTER_TENANT_ID);
    expect(masterChildren.map((t) => t.name)).toEqual(['A']);

    const aChildren = await repo.listChildren(a.id);
    expect(aChildren.map((t) => t.name).sort()).toEqual(['A.1', 'A.2']);
  });

  it('returns empty array for getAncestors of a nonexistent tenant', async () => {
    const chain = await repo.getAncestors('00000000-0000-7000-8000-000000000000');
    expect(chain).toEqual([]);
  });

  it('update mutates name and bumps updated_at', async () => {
    const a = await repo.create({ name: 'A', parentId: MASTER_TENANT_ID });
    const before = a.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 10));
    const updated = await repo.update(a.id, { name: 'A-prime' });
    expect(updated?.name).toBe('A-prime');
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(before);
  });

  describe('delete-blocker counts', () => {
    it('countChildren reports direct children only', async () => {
      const a = await repo.create({ name: 'A', parentId: MASTER_TENANT_ID });
      const b = await repo.create({ name: 'B', parentId: a.id });
      await repo.create({ name: 'B.1', parentId: b.id });
      expect(await repo.countChildren(MASTER_TENANT_ID)).toBe(1);
      expect(await repo.countChildren(a.id)).toBe(1);
      expect(await repo.countChildren(b.id)).toBe(1);
    });

    it('countApiKeys counts both active and revoked keys', async () => {
      const { db } = getTestDb();
      const tenant = await repo.create({ name: 't', parentId: MASTER_TENANT_ID });
      const apiKeys = new ApiKeysRepository(db);

      expect(await repo.countApiKeys(tenant.id)).toBe(0);

      const k1 = await apiKeys.create({ label: 'live', tenantId: tenant.id });
      const k2 = await apiKeys.create({ label: 'doomed', tenantId: tenant.id });
      expect(await repo.countApiKeys(tenant.id)).toBe(2);

      await apiKeys.revoke(k2.row.id);
      expect(await repo.countApiKeys(tenant.id)).toBe(2);
      // The other tenant's count is unaffected.
      expect(await repo.countApiKeys(MASTER_TENANT_ID)).toBe(0);
      void k1; // referenced for clarity
    });

    it('countActiveBindings excludes revoked and expired bindings', async () => {
      const { db } = getTestDb();
      const tenant = await repo.create({ name: 't', parentId: MASTER_TENANT_ID });
      const users = new UsersRepository(db);
      const principals = new PrincipalsRepository(db);
      const rolesRepo = new RolesRepository(db);
      const bindings = new RoleBindingsRepository(db);

      const user = await users.upsertByEmailId('e@x');
      const principal = await principals.ensureForUser(user.id);
      const role = await rolesRepo.create({ tenantId: tenant.id, name: 'r' });

      expect(await repo.countActiveBindings(tenant.id)).toBe(0);

      const active = await bindings.create({
        principalId: principal.id,
        roleId: role.id,
        tenantId: tenant.id,
      });
      expect(await repo.countActiveBindings(tenant.id)).toBe(1);

      // Add a binding that's already expired — should not count.
      const user2 = await users.upsertByEmailId('e2@x');
      const principal2 = await principals.ensureForUser(user2.id);
      await bindings.create({
        principalId: principal2.id,
        roleId: role.id,
        tenantId: tenant.id,
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(await repo.countActiveBindings(tenant.id)).toBe(1);

      // Revoke the active one — count drops to zero.
      await bindings.revoke(active.id);
      expect(await repo.countActiveBindings(tenant.id)).toBe(0);
    });
  });
});
