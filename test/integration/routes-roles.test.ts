import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('routes: /roles', () => {
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

  async function createOrg(adminToken: string): Promise<string> {
    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `org-${Date.now()}`, parentId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(200);
    return res.json<{ data: { id: string } }>().data.id;
  }

  it('admin can create a role at a tenant', async () => {
    const admin = await t.adminToken();
    const orgId = await createOrg(admin.token);
    // Admin's binding was created BEFORE the org existed → no tuple at org.
    // Re-grant at the new tenant so subsequent calls land.
    await t.grantAdminAt(admin.principalId, orgId);

    const res = await t.app.inject({
      method: 'POST',
      url: `/tenants/${orgId}/roles`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'editor', description: 'can edit', crossesBoundary: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { name: string; tenantId: string } }>();
    expect(body.data.name).toBe('editor');
    expect(body.data.tenantId).toBe(orgId);
  });

  it('GET /roles/:id returns role with scopes', async () => {
    const admin = await t.adminToken();
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'reader',
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `/roles/${role.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { role: { id: string }; scopes: unknown[] } }>();
    expect(body.data.role.id).toBe(role.id);
    expect(body.data.scopes).toEqual([]);
  });

  it('addScopes emits role.scope_added outbox events', async () => {
    const admin = await t.adminToken();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'r1' });
    const scope = await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'doc:read' });

    const res = await t.app.inject({
      method: 'POST',
      url: `/roles/${role.id}/scopes`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { scopeIds: [scope.id] },
    });
    expect(res.statusCode).toBe(200);

    const outbox = new OutboxRepository(t.db);
    const pending = await outbox.listPending();
    const added = pending.find(
      (e) =>
        e.eventType === 'role.scope_added' && (e.payload as { roleId: string }).roleId === role.id,
    );
    expect(added).toBeDefined();
  });

  it('removeScope emits role.scope_removed and updates the membership', async () => {
    const admin = await t.adminToken();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'r2' });
    const scope = await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'doc:write' });
    await t.services.roles.addScopes(role.id, [scope.id]);

    const res = await t.app.inject({
      method: 'DELETE',
      url: `/roles/${role.id}/scopes/${scope.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(204);

    const outbox = new OutboxRepository(t.db);
    const pending = await outbox.listPending();
    const removed = pending.find(
      (e) =>
        e.eventType === 'role.scope_removed' &&
        (e.payload as { scopeId: string }).scopeId === scope.id,
    );
    expect(removed).toBeDefined();

    const after = await t.services.roles.getWithScopes(role.id);
    expect(after.scopes).toEqual([]);
  });

  it('403 when authed but lacks roles:write', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'POST',
      url: `/tenants/${MASTER_TENANT_ID}/roles`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'sneaky' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 on GET /roles/:id with unknown id', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/roles/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ──────────────────────────────────────────────────────────────────────
  // PATCH /roles/:id
  // ──────────────────────────────────────────────────────────────────────

  it('admin can update name + description in one call', async () => {
    const admin = await t.adminToken();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'patch-r' });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/roles/${role.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'patch-r-renamed', description: 'now described' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { name: string; description: string | null } }>();
    expect(body.data.name).toBe('patch-r-renamed');
    expect(body.data.description).toBe('now described');
  });

  it('409 on rename collision with existing role in same tenant', async () => {
    const admin = await t.adminToken();
    const taken = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'collide-taken',
    });
    void taken;
    const target = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'collide-target',
    });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/roles/${target.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'collide-taken' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('PATCH 403 when caller lacks roles:write at the role tenant', async () => {
    const user = await t.ensureUser();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'guarded' });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/roles/${role.id}`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'sneaky' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH 404 on unknown role id', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'PATCH',
      url: '/roles/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('PATCH 400 on unknown field (strict schema rejects crossesBoundary)', async () => {
    const admin = await t.adminToken();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'strict-r' });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/roles/${role.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { crossesBoundary: true },
    });
    expect(res.statusCode).toBe(400);
  });
});
