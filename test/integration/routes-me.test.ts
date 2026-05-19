import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

interface PermissionsResp {
  data: { tenantId: string; scopes: { id: string; name: string; description: string | null }[] };
}

describe.skipIf(!reachable)('routes: /me', () => {
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

  it('GET /me returns identity', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { principalId: string; kind: string; userId: string | null };
    }>();
    expect(body.data.principalId).toBe(user.principalId);
    expect(body.data.kind).toBe('user');
    expect(body.data.userId).toBe(user.userId);
  });

  it('GET /me 401 without auth', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /me/permissions 400 without tenantId', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'GET',
      url: '/me/permissions',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /me/permissions returns the admin scope list at master', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: `/me/permissions?tenantId=${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PermissionsResp>();
    expect(body.data.tenantId).toBe(MASTER_TENANT_ID);
    const names = body.data.scopes.map((s) => s.name);
    // Admin role holds every system scope (see SYSTEM_SCOPE_NAMES).
    expect(names).toEqual(
      [
        'api_keys:manage',
        'bindings:manage',
        'outbox:read',
        'outbox:write',
        'permissions:check',
        'roles:read',
        'roles:write',
        'scopes:read',
        'scopes:write',
        'tenants:read',
        'tenants:write',
        'users:read',
        'users:write',
      ].sort(),
    );
  });

  it('GET /me/permissions returns empty when caller has no grants at the tenant', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'GET',
      url: `/me/permissions?tenantId=${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PermissionsResp>();
    expect(body.data.scopes).toEqual([]);
  });

  it('GET /me/permissions reflects inherited grants at a descendant tenant', async () => {
    const user = await t.ensureUser();
    const child = await t.services.tenants.create({
      name: 'me-perm-child',
      parentId: MASTER_TENANT_ID,
    });
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'inh:permission',
    });
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'inh-perm-role',
      crossesBoundary: false,
    });
    await t.services.roles.addScopes(role.id, [scope.id]);
    await t.services.bindings.create({
      principalId: user.principalId,
      roleId: role.id,
      tenantId: MASTER_TENANT_ID,
    });
    for (;;) {
      const r = await t.worker.runOnce();
      if (r.claimed === 0) break;
    }

    const res = await t.app.inject({
      method: 'GET',
      url: `/me/permissions?tenantId=${child.id}`,
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<PermissionsResp>();
    expect(body.data.scopes.map((s) => s.name)).toContain('inh:permission');
  });
});
