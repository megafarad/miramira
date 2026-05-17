import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('routes: /api-keys', () => {
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

  it('admin can mint a key; secret is returned exactly once', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { label: 'ci-key', tenantId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      data: { id: string; secret: string; keyPrefix: string; principalId: string };
    }>();
    expect(body.data.secret).toMatch(/^mrm_/);
    expect(body.data.keyPrefix).toMatch(/^mrm_/);
    expect(body.data.principalId).toBeTruthy();

    const list = await t.app.inject({
      method: 'GET',
      url: `/api-keys?tenantId=${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json<{ data: Record<string, unknown>[] }>();
    const mine = listBody.data.find((k) => k.id === body.data.id);
    expect(mine).toBeDefined();
    // Sensitive fields never returned on list.
    expect(Object.keys(mine ?? {})).not.toContain('secret');
    expect(Object.keys(mine ?? {})).not.toContain('keyHash');
  });

  it('minted key can authenticate via X-API-Key header', async () => {
    const admin = await t.adminToken();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { label: 'svc-key', tenantId: MASTER_TENANT_ID },
    });
    const { secret, principalId } = created.json<{
      data: { secret: string; principalId: string };
    }>().data;

    // Without bindings the key authenticates but has no scopes → /me works.
    const me = await t.app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-api-key': secret },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json<{ data: { principalId: string; kind: string } }>();
    expect(meBody.data.principalId).toBe(principalId);
    expect(meBody.data.kind).toBe('api_key');
  });

  it('revoke marks the key revoked; subsequent X-API-Key auth fails', async () => {
    const admin = await t.adminToken();
    const created = await t.app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { label: 'doomed', tenantId: MASTER_TENANT_ID },
    });
    const { id, secret } = created.json<{ data: { id: string; secret: string } }>().data;

    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api-keys/${id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(del.statusCode).toBe(204);

    const me = await t.app.inject({
      method: 'GET',
      url: '/me',
      headers: { 'x-api-key': secret },
    });
    expect(me.statusCode).toBe(401);
  });

  it('403 when caller lacks api_keys:manage', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { label: 'nope', tenantId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(403);
  });

  it('404 on DELETE /api-keys/:id with unknown id', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/api-keys/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
