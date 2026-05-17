import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('routes: /scopes', () => {
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

  it('admin can create + list scopes at master', async () => {
    const admin = await t.adminToken();
    const created = await t.app.inject({
      method: 'POST',
      url: `/tenants/${MASTER_TENANT_ID}/scopes`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'docs:read' },
    });
    expect(created.statusCode).toBe(200);

    const list = await t.app.inject({
      method: 'GET',
      url: `/tenants/${MASTER_TENANT_ID}/scopes`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{ data: { name: string }[] }>();
    expect(body.data.some((s) => s.name === 'docs:read')).toBe(true);
  });

  it('GET /scopes/:id requires scopes:read at the scope tenant', async () => {
    const admin = await t.adminToken();
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'docs:write',
    });
    const res = await t.app.inject({
      method: 'GET',
      url: `/scopes/${scope.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; name: string } }>();
    expect(body.data.name).toBe('docs:write');
  });

  it('409 on duplicate scope name within tenant', async () => {
    const admin = await t.adminToken();
    await t.app.inject({
      method: 'POST',
      url: `/tenants/${MASTER_TENANT_ID}/scopes`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'dup:scope' },
    });
    const dup = await t.app.inject({
      method: 'POST',
      url: `/tenants/${MASTER_TENANT_ID}/scopes`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'dup:scope' },
    });
    // ScopesService.create wraps the Postgres unique-violation as ConflictError
    // (→ 409) via the wrapConflict helper.
    expect(dup.statusCode).toBe(409);
  });

  it('403 when authed but no scopes:write', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'POST',
      url: `/tenants/${MASTER_TENANT_ID}/scopes`,
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'sneaky:scope' },
    });
    expect(res.statusCode).toBe(403);
  });

  // ──────────────────────────────────────────────────────────────────────
  // PATCH /scopes/:id
  // ──────────────────────────────────────────────────────────────────────

  it('admin can rename a scope', async () => {
    const admin = await t.adminToken();
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'rename:before',
    });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/scopes/${scope.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'rename:after' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; name: string } }>();
    expect(body.data.id).toBe(scope.id);
    expect(body.data.name).toBe('rename:after');
  });

  it('after rename, /check with new name resolves; old name returns false', async () => {
    const user = await t.ensureUser();
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'rename:old',
    });
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'rename-role',
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

    // Sanity: works with original name.
    let res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'rename:old' },
    });
    expect(res.json<{ data: { allowed: boolean } }>().data.allowed).toBe(true);

    const admin = await t.adminToken();
    const patch = await t.app.inject({
      method: 'PATCH',
      url: `/scopes/${scope.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'rename:new' },
    });
    expect(patch.statusCode).toBe(200);

    // New name resolves (FGA tuple is still keyed by scope id).
    res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'rename:new' },
    });
    expect(res.json<{ data: { allowed: boolean } }>().data.allowed).toBe(true);

    // Old name no longer in scopes table → resolves to false.
    res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'rename:old' },
    });
    expect(res.json<{ data: { allowed: boolean } }>().data.allowed).toBe(false);
  });

  it('409 on rename collision within same tenant', async () => {
    const admin = await t.adminToken();
    const a = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'collide:a',
    });
    await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'collide:b' });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/scopes/${a.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'collide:b' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('400 on body containing only an unrelated field', async () => {
    const admin = await t.adminToken();
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'strict:check',
    });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/scopes/${scope.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { tenantId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 on empty body', async () => {
    const admin = await t.adminToken();
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'empty:patch',
    });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/scopes/${scope.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
