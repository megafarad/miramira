import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

interface PageBody<T> {
  data: T[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

interface ErrorBody {
  error: string;
}

// Walk every page of a paginated endpoint until exhausted. Returns the
// concatenated items. Asserts each page respects the requested limit.
async function walk<T extends { id: string }>(
  t: TestApp,
  buildUrl: (cursor?: string) => string,
  token: string,
  limit: number,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const url = buildUrl(cursor);
    const res = await t.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PageBody<T>>();
    expect(body.data.length).toBeLessThanOrEqual(limit);
    all.push(...body.data);
    if (!body.pageInfo.nextCursor) {
      expect(body.pageInfo.hasMore).toBe(false);
      return all;
    }
    expect(body.pageInfo.hasMore).toBe(true);
    cursor = body.pageInfo.nextCursor;
  }
  throw new Error('walk did not terminate within 50 pages');
}

describe.skipIf(!reachable)('pagination contract', () => {
  let t: TestApp;
  let admin: { token: string; principalId: string };

  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(async () => {
    await t.resetDb();
    admin = await t.adminToken();
  });
  afterAll(async () => {
    await t.cleanup();
    await closeTestDb();
  });

  describe('limit validation', () => {
    it('rejects limit > 200', async () => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/tenants/${MASTER_TENANT_ID}/scopes?limit=201`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<ErrorBody>().error).toBeTruthy();
    });

    it('rejects limit < 1', async () => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/tenants/${MASTER_TENANT_ID}/scopes?limit=0`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-uuid cursor', async () => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/tenants/${MASTER_TENANT_ID}/scopes?cursor=not-a-uuid`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /tenants/:id/children', () => {
    it('paginates children deterministically', async () => {
      // Seed: 7 children of master.
      for (let i = 0; i < 7; i++) {
        await t.services.tenants.create({
          name: `child-${i.toString().padStart(2, '0')}`,
          parentId: MASTER_TENANT_ID,
        });
      }
      const items = await walk<{ id: string; name: string }>(
        t,
        (cursor) =>
          `/tenants/${MASTER_TENANT_ID}/children?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
        admin.token,
        3,
      );
      expect(items).toHaveLength(7);
      // All ids unique.
      expect(new Set(items.map((x) => x.id)).size).toBe(7);
      // Sorted ascending by id (UUIDv7 ⇒ creation order).
      const ids = items.map((x) => x.id);
      const sorted = [...ids].sort();
      expect(ids).toEqual(sorted);
    });
  });

  describe('GET /tenants/:tenantId/roles', () => {
    it('paginates roles at a tenant', async () => {
      // Master already has the admin role (1). Add 4 more = 5 total.
      for (let i = 0; i < 4; i++) {
        await t.services.roles.create({
          tenantId: MASTER_TENANT_ID,
          name: `role-${i}`,
        });
      }
      const items = await walk<{ id: string }>(
        t,
        (cursor) =>
          `/tenants/${MASTER_TENANT_ID}/roles?limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        admin.token,
        2,
      );
      expect(items.length).toBeGreaterThanOrEqual(5);
      expect(new Set(items.map((x) => x.id)).size).toBe(items.length);
    });
  });

  describe('GET /tenants/:tenantId/scopes', () => {
    it('paginates scopes at a tenant', async () => {
      // Master already has the 9 system scopes. Add 3 more = 12 total.
      for (let i = 0; i < 3; i++) {
        await t.services.scopes.create({
          tenantId: MASTER_TENANT_ID,
          name: `widgets:action${i}`,
        });
      }
      const items = await walk<{ id: string }>(
        t,
        (cursor) =>
          `/tenants/${MASTER_TENANT_ID}/scopes?limit=5${cursor ? `&cursor=${cursor}` : ''}`,
        admin.token,
        5,
      );
      expect(items.length).toBeGreaterThanOrEqual(12);
      expect(new Set(items.map((x) => x.id)).size).toBe(items.length);
    });

    it('last page returns nextCursor=null, hasMore=false', async () => {
      // Master has 9 system scopes. limit=100 ⇒ all in one page.
      const res = await t.app.inject({
        method: 'GET',
        url: `/tenants/${MASTER_TENANT_ID}/scopes?limit=100`,
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<PageBody<{ id: string }>>();
      expect(body.pageInfo.nextCursor).toBeNull();
      expect(body.pageInfo.hasMore).toBe(false);
    });
  });

  describe('GET /api-keys', () => {
    it('paginates api keys at a tenant', async () => {
      for (let i = 0; i < 6; i++) {
        await t.services.apiKeys.create({
          tenantId: MASTER_TENANT_ID,
          label: `key-${i}`,
        });
      }
      const items = await walk<{ id: string }>(
        t,
        (cursor) =>
          `/api-keys?tenantId=${MASTER_TENANT_ID}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        admin.token,
        2,
      );
      expect(items).toHaveLength(6);
      expect(new Set(items.map((x) => x.id)).size).toBe(6);
    });
  });

  describe('GET /role-bindings', () => {
    it('paginates bindings at a tenant', async () => {
      // Seed: 5 users, each bound to admin at master. adminToken() already
      // created one binding, so we expect 6 total.
      for (let i = 0; i < 5; i++) {
        const u = await t.ensureUser();
        await t.services.bindings.create({
          principalId: u.principalId,
          roleId: (await t.services.roles.pageByTenant(MASTER_TENANT_ID, { limit: 1 }))
            .items[0]!.id,
          tenantId: MASTER_TENANT_ID,
        });
      }
      const items = await walk<{ id: string }>(
        t,
        (cursor) =>
          `/role-bindings?tenantId=${MASTER_TENANT_ID}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        admin.token,
        2,
      );
      expect(items.length).toBeGreaterThanOrEqual(6);
      expect(new Set(items.map((x) => x.id)).size).toBe(items.length);
    });
  });
});
