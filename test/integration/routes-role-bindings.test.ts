import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('routes: /role-bindings', () => {
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

  it('admin can create a binding; worker materializes the FGA tuple', async () => {
    const admin = await t.adminToken();
    const targetUser = await t.ensureUser();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'editor' });
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'pages:edit',
    });
    await t.services.roles.addScopes(role.id, [scope.id]);
    // Drain the role.scope_added events (no-op in dispatcher).
    await t.worker.runOnce();

    const created = await t.app.inject({
      method: 'POST',
      url: '/role-bindings',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        principalId: targetUser.principalId,
        roleId: role.id,
        tenantId: MASTER_TENANT_ID,
      },
    });
    expect(created.statusCode).toBe(201);

    // Worker materializes the binding into FGA.
    const drain = await t.worker.runOnce();
    expect(drain.failed).toBe(0);

    const check = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${targetUser.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'pages:edit' },
    });
    expect(check.statusCode).toBe(200);
    expect(check.json<{ data: { allowed: boolean } }>().data.allowed).toBe(true);
  });

  it('revoke removes FGA grants after worker run', async () => {
    const admin = await t.adminToken();
    const targetUser = await t.ensureUser();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'r-rev' });
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'p:rev',
    });
    await t.services.roles.addScopes(role.id, [scope.id]);
    await t.worker.runOnce();

    const created = await t.app.inject({
      method: 'POST',
      url: '/role-bindings',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        principalId: targetUser.principalId,
        roleId: role.id,
        tenantId: MASTER_TENANT_ID,
      },
    });
    const { id: bindingId } = created.json<{ data: { id: string } }>().data;
    await t.worker.runOnce();

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/role-bindings/${bindingId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);
    await t.worker.runOnce();

    const check = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${targetUser.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'p:rev' },
    });
    expect(check.json<{ data: { allowed: boolean } }>().data.allowed).toBe(false);
  });

  it('GET /role-bindings filters by tenantId and principalId', async () => {
    const admin = await t.adminToken();
    const targetUser = await t.ensureUser();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'r-list' });

    await t.app.inject({
      method: 'POST',
      url: '/role-bindings',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        principalId: targetUser.principalId,
        roleId: role.id,
        tenantId: MASTER_TENANT_ID,
      },
    });

    const list = await t.app.inject({
      method: 'GET',
      url: `/role-bindings?tenantId=${MASTER_TENANT_ID}&principalId=${targetUser.principalId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ data: { principalId: string }[] }>();
    expect(body.data.every((b) => b.principalId === targetUser.principalId)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('403 when caller lacks bindings:manage at tenantId', async () => {
    const user = await t.ensureUser();
    const role = await t.services.roles.create({ tenantId: MASTER_TENANT_ID, name: 'r-403' });
    const res = await t.app.inject({
      method: 'POST',
      url: '/role-bindings',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        principalId: user.principalId,
        roleId: role.id,
        tenantId: MASTER_TENANT_ID,
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /role-bindings requires tenantId query param', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/role-bindings',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
