import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

interface AuditPageBody {
  data: { id: string; action: string; requestId: string; targetId: string | null }[];
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}

interface AuditEntryBody {
  data: { id: string; action: string };
}

describe.skipIf(!reachable)('routes: /admin/audit', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await buildTestApp();
  });
  beforeEach(async () => {
    await t.resetDb();
  });
  afterAll(async () => {
    await t.cleanup();
    await closeTestDb();
  });

  it('401 without credentials', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/audit' });
    expect(res.statusCode).toBe(401);
  });

  it('403 when authed but lacking audit:read', async () => {
    const caller = await t.ensureUser();
    const res = await t.app.inject({
      method: 'GET',
      url: '/admin/audit',
      headers: { authorization: `Bearer ${caller.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin sees audit rows produced by other mutations', async () => {
    const admin = await t.adminToken();
    // Trigger an audited action: create a tenant under master.
    const created = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'audited-org', parentId: MASTER_TENANT_ID },
    });
    expect(created.statusCode).toBe(200);
    const tenantId = created.json<{ data: { id: string } }>().data.id;

    const list = await t.app.inject({
      method: 'GET',
      url: `/admin/audit?targetType=tenant&targetId=${tenantId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<AuditPageBody>();
    const matching = body.data.filter((r) => r.action === 'tenant.create');
    expect(matching).toHaveLength(1);
    expect(matching[0]?.targetId).toBe(tenantId);
  });

  it('cursor round-trip splits a multi-row result correctly', async () => {
    const admin = await t.adminToken();
    // Three audited writes → three audit rows on the tenant target_type.
    for (const name of ['a', 'b', 'c']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/tenants',
        headers: { authorization: `Bearer ${admin.token}` },
        payload: { name, parentId: MASTER_TENANT_ID },
      });
      expect(res.statusCode).toBe(200);
    }

    const first = await t.app.inject({
      method: 'GET',
      url: '/admin/audit?action=tenant.create&limit=2',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const firstBody = first.json<AuditPageBody>();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.pageInfo.hasMore).toBe(true);
    expect(firstBody.pageInfo.nextCursor).not.toBeNull();

    const second = await t.app.inject({
      method: 'GET',
      url: `/admin/audit?action=tenant.create&limit=2&cursor=${firstBody.pageInfo.nextCursor}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const secondBody = second.json<AuditPageBody>();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.pageInfo.hasMore).toBe(false);
    expect(secondBody.pageInfo.nextCursor).toBeNull();
  });

  it('400 when querystring fails validation (e.g. non-uuid targetId)', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/admin/audit?targetId=not-a-uuid',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /admin/audit/:id returns the entry', async () => {
    const admin = await t.adminToken();
    const created = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'fetch-me', parentId: MASTER_TENANT_ID },
    });
    const tenantId = created.json<{ data: { id: string } }>().data.id;

    const list = await t.app.inject({
      method: 'GET',
      url: `/admin/audit?targetId=${tenantId}&action=tenant.create`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const auditId = list.json<AuditPageBody>().data[0]?.id;
    expect(auditId).toBeDefined();

    const get = await t.app.inject({
      method: 'GET',
      url: `/admin/audit/${auditId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<AuditEntryBody>().data.id).toBe(auditId);
  });

  it('GET /admin/audit/:id returns 404 for an unknown id', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/admin/audit/00000000-0000-7000-8000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
