import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { TenantsRepository } from '../../src/repositories/tenants.js';
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
});
