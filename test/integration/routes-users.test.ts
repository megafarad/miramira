import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

interface UserBody {
  data: {
    id: string;
    email: string;
    supabaseUserId: string | null;
    disabledAt: string | null;
    deletedAt: string | null;
  };
}

interface RevokeBody {
  data: { revoked: number; bindingIds: string[] };
}

describe.skipIf(!reachable)('routes: /users', () => {
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
    const target = await t.ensureUser({ email: 'target@x' });
    const res = await t.app.inject({ method: 'GET', url: `/users/${target.userId}` });
    expect(res.statusCode).toBe(401);
  });

  it('403 when authed user lacks users:read', async () => {
    const caller = await t.ensureUser();
    const target = await t.ensureUser({ email: 'target@x' });
    const res = await t.app.inject({
      method: 'GET',
      url: `/users/${target.userId}`,
      headers: { authorization: `Bearer ${caller.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /users/:id returns the user (including timestamps)', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: `/users/${admin.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<UserBody>();
    expect(body.data.id).toBe(admin.userId);
    expect(body.data.email).toBe(admin.email);
    expect(body.data.disabledAt).toBeNull();
    expect(body.data.deletedAt).toBeNull();
  });

  it('POST /users/:id/disable then enable flips disabled_at', async () => {
    const admin = await t.adminToken();
    const target = await t.ensureUser({ email: 'flipme@x' });

    const off = await t.app.inject({
      method: 'POST',
      url: `/users/${target.userId}/disable`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json<UserBody>().data.disabledAt).not.toBeNull();

    const on = await t.app.inject({
      method: 'POST',
      url: `/users/${target.userId}/enable`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json<UserBody>().data.disabledAt).toBeNull();
  });

  it('POST /users/:id/revoke-all-bindings returns the count and revokes them', async () => {
    const admin = await t.adminToken();
    // admin token bootstraps an admin binding at MASTER. Revoking it should
    // return revoked >= 1 and leave a clean audit trail. Using the admin as
    // the subject keeps the test self-contained — no extra fixture wiring.
    const res = await t.app.inject({
      method: 'POST',
      url: `/users/${admin.userId}/revoke-all-bindings`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<RevokeBody>();
    expect(body.data.revoked).toBeGreaterThanOrEqual(1);
    expect(body.data.bindingIds.length).toBe(body.data.revoked);
  });

  it('DELETE /users/:id 409 when active bindings exist; 204 after revoke-all', async () => {
    const admin = await t.adminToken();
    const target = await t.adminToken({ email: 'bound@x' });

    // target has an admin binding at MASTER from adminToken; DELETE should block.
    const blocked = await t.app.inject({
      method: 'DELETE',
      url: `/users/${target.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json<{ error: string }>().error).toContain('role_binding');

    const revoke = await t.app.inject({
      method: 'POST',
      url: `/users/${target.userId}/revoke-all-bindings`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(revoke.statusCode).toBe(200);

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/users/${target.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);

    // After delete, GET still finds the row (soft-delete) — admin can see the
    // tombstone for forensics.
    const get = await t.app.inject({
      method: 'GET',
      url: `/users/${target.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(get.statusCode).toBe(200);
    expect(get.json<UserBody>().data.deletedAt).not.toBeNull();
  });

  it('DELETE /users/:id second time 404s', async () => {
    const admin = await t.adminToken();
    const target = await t.ensureUser({ email: 'dies@x' });

    const first = await t.app.inject({
      method: 'DELETE',
      url: `/users/${target.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(first.statusCode).toBe(204);

    const second = await t.app.inject({
      method: 'DELETE',
      url: `/users/${target.userId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(second.statusCode).toBe(404);
  });

  it('disabled user gets 401 on subsequent requests', async () => {
    const admin = await t.adminToken();
    const victim = await t.adminToken({ email: 'kick@x' });

    // Sanity check: victim can authenticate before disable.
    const before = await t.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${victim.token}` },
    });
    expect(before.statusCode).toBe(200);

    const off = await t.app.inject({
      method: 'POST',
      url: `/users/${victim.userId}/disable`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(off.statusCode).toBe(200);

    const after = await t.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${victim.token}` },
    });
    expect(after.statusCode).toBe(401);
  });
});
