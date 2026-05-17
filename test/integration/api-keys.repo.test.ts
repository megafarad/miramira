import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { ApiKeysRepository } from '../../src/repositories/api-keys.js';
import { TenantsRepository } from '../../src/repositories/tenants.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

describe.skipIf(!(await isDbReachable()))('ApiKeysRepository', () => {
  let keys: ApiKeysRepository;
  let tenants: TenantsRepository;

  beforeAll(() => {
    const { db } = getTestDb();
    keys = new ApiKeysRepository(db);
    tenants = new TenantsRepository(db);
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('create returns a secret once and stores only the hash', async () => {
    const { row, secret } = await keys.create({
      label: 'CI deploy key',
      tenantId: MASTER_TENANT_ID,
    });
    expect(secret).toMatch(/^mrm_/);
    expect(row.keyHash).toHaveLength(64);
    expect(row.keyHash).not.toBe(secret);
    expect(row.keyPrefix.startsWith('mrm_')).toBe(true);
  });

  it('findActiveBySecret round-trips a freshly minted key', async () => {
    const { secret, row } = await keys.create({
      label: 'k1',
      tenantId: MASTER_TENANT_ID,
    });
    const found = await keys.findActiveBySecret(secret);
    expect(found?.id).toBe(row.id);
  });

  it('findActiveBySecret returns undefined for an unknown secret', async () => {
    expect(await keys.findActiveBySecret('mrm_nope')).toBeUndefined();
  });

  it('revoked keys no longer authenticate', async () => {
    const { secret, row } = await keys.create({ label: 'k', tenantId: MASTER_TENANT_ID });
    await keys.revoke(row.id);
    expect(await keys.findActiveBySecret(secret)).toBeUndefined();
  });

  it('expired keys no longer authenticate', async () => {
    const past = new Date(Date.now() - 1000);
    const { secret } = await keys.create({
      label: 'k',
      tenantId: MASTER_TENANT_ID,
      expiresAt: past,
    });
    expect(await keys.findActiveBySecret(secret)).toBeUndefined();
  });

  it('listForTenant scopes results to the given tenant', async () => {
    const orgA = await tenants.create({ name: 'A', parentId: MASTER_TENANT_ID });
    const orgB = await tenants.create({ name: 'B', parentId: MASTER_TENANT_ID });
    await keys.create({ label: 'a1', tenantId: orgA.id });
    await keys.create({ label: 'a2', tenantId: orgA.id });
    await keys.create({ label: 'b1', tenantId: orgB.id });

    const aKeys = await keys.listForTenant(orgA.id);
    expect(aKeys.map((k) => k.label).sort()).toEqual(['a1', 'a2']);
  });

  it('touchLastUsed sets last_used_at', async () => {
    const { row } = await keys.create({ label: 'k', tenantId: MASTER_TENANT_ID });
    expect(row.lastUsedAt).toBeNull();
    const when = new Date();
    await keys.touchLastUsed(row.id, when);
    const refreshed = await keys.findById(row.id);
    expect(refreshed?.lastUsedAt?.getTime()).toBe(when.getTime());
  });
});
