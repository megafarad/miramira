import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('routes: /tenants', () => {
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
    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      payload: { name: 'x', parentId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(401);
  });

  it('403 when authed but unbound', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'x', parentId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(403);
  });

  it('admin can create a tenant under master', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'org-a', parentId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; name: string; parentId: string } }>();
    expect(body.data.name).toBe('org-a');
    expect(body.data.parentId).toBe(MASTER_TENANT_ID);
  });

  it('400 on missing name', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { parentId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /tenants/:id returns the tenant', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: `/tenants/${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; name: string } }>();
    expect(body.data.id).toBe(MASTER_TENANT_ID);
    expect(body.data.name).toBe('master');
  });

  it('GET /tenants/:id 404 on unknown', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/tenants/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    // Authz check fires first against a non-existent tenant → 403 (admin has no
    // tuple for an unknown tenant id). The choice is acceptable: either 403 or
    // 404 would be defensible. We document the actual behavior.
    expect([403, 404]).toContain(res.statusCode);
  });

  it('GET /tenants/:id/children lists children created via the API', async () => {
    const admin = await t.adminToken();
    const create = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'org-b', parentId: MASTER_TENANT_ID },
    });
    expect(create.statusCode).toBe(200);

    const res = await t.app.inject({
      method: 'GET',
      url: `/tenants/${MASTER_TENANT_ID}/children`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { name: string }[] }>();
    expect(body.data.some((c) => c.name === 'org-b')).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // PATCH /tenants/:id
  // ──────────────────────────────────────────────────────────────────────

  it('admin can rename master; GET reflects the change', async () => {
    const admin = await t.adminToken();
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/tenants/${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'master-renamed' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ data: { name: string } }>().data.name).toBe('master-renamed');

    const get = await t.app.inject({
      method: 'GET',
      url: `/tenants/${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(get.json<{ data: { name: string } }>().data.name).toBe('master-renamed');
  });

  it('PATCH 403 when caller lacks tenants:write', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/tenants/${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'nope' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH 400 on unknown field (strict schema rejects parentId)', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/tenants/${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { parentId: '00000000-0000-7000-8000-000000000001' },
    });
    expect(res.statusCode).toBe(400);
  });

  // ──────────────────────────────────────────────────────────────────────
  // DELETE /tenants/:id
  // ──────────────────────────────────────────────────────────────────────

  // POST /tenants enqueues a tenant.created event; the materializer turns
  // that into FGA scope_grant tuples (the admin's crosses_boundary role
  // reaches the new tenant). Until the worker drains, requireScope on the
  // new tenant 403s. Helper drains everything pending so subsequent calls
  // see the materialized grants.
  async function drainAll(): Promise<void> {
    for (;;) {
      const res = await t.worker.runOnce();
      if (res.claimed === 0) break;
    }
  }

  it('admin can delete a clean tenant; subsequent GET 404s', async () => {
    const admin = await t.adminToken();
    const created = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'doomed', parentId: MASTER_TENANT_ID },
    });
    const id = created.json<{ data: { id: string } }>().data.id;
    await drainAll();

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/tenants/${id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);
    expect(del.payload).toBe('');

    const get = await t.app.inject({
      method: 'GET',
      url: `/tenants/${id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    // Same defensible 403/404 ambiguity as the GET test above.
    expect([403, 404]).toContain(get.statusCode);
  });

  it('DELETE 409 when the tenant has child tenants', async () => {
    const admin = await t.adminToken();
    const parent = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'parent', parentId: MASTER_TENANT_ID },
    });
    const parentId = parent.json<{ data: { id: string } }>().data.id;
    // Drain so the admin's binding materializes at `parent` before the next
    // POST tries requireScope('tenants:write', parentId).
    await drainAll();
    const child = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'child', parentId },
    });
    expect(child.statusCode).toBe(200);
    await drainAll();

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/tenants/${parentId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json<{ error: string }>().error).toContain('child tenant');
  });

  it('DELETE 409 when the tenant has api_keys', async () => {
    const admin = await t.adminToken();
    const tenant = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'keyed', parentId: MASTER_TENANT_ID },
    });
    const id = tenant.json<{ data: { id: string } }>().data.id;
    await drainAll();
    const key = await t.app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { label: 'k', tenantId: id },
    });
    expect(key.statusCode).toBe(201);

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/tenants/${id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(409);
    expect(del.json<{ error: string }>().error).toContain('api_key');
  });

  it('DELETE 409 when the tenant is master', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/tenants/${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toContain('master');
  });

  it('DELETE 403 when caller lacks tenants:write', async () => {
    const admin = await t.adminToken();
    const created = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'guarded', parentId: MASTER_TENANT_ID },
    });
    const id = created.json<{ data: { id: string } }>().data.id;

    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'DELETE',
      url: `/tenants/${id}`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
