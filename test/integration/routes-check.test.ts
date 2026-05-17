import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

interface CheckResp {
  data: { allowed: boolean };
}

describe.skipIf(!reachable)('routes: /check', () => {
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

  async function bind(principalId: string, scopeName: string, tenantId: string): Promise<void> {
    const role = await t.services.roles.create({
      tenantId,
      name: `r-${scopeName}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
    const scope = await t.services.scopes.create({ tenantId, name: scopeName });
    await t.services.roles.addScopes(role.id, [scope.id]);
    await t.services.bindings.create({
      principalId,
      roleId: role.id,
      tenantId,
    });
    for (;;) {
      const r = await t.worker.runOnce();
      if (r.claimed === 0) break;
    }
  }

  it('self-check returns true when caller holds the scope', async () => {
    const user = await t.ensureUser();
    await bind(user.principalId, 'self:read', MASTER_TENANT_ID);

    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'self:read' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CheckResp>().data.allowed).toBe(true);
  });

  it('self-check returns false when caller lacks the scope', async () => {
    const user = await t.ensureUser();
    // No bindings — but we need the scope to exist for the resolver to find it.
    await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'unbound:read' });

    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'unbound:read' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CheckResp>().data.allowed).toBe(false);
  });

  it('subject by sub: admin checks on behalf of another user', async () => {
    const admin = await t.adminToken();
    const target = await t.ensureUser();
    await bind(target.principalId, 'subject:sub', MASTER_TENANT_ID);

    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        tenantId: MASTER_TENANT_ID,
        scope: 'subject:sub',
        subject: { sub: target.sub },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CheckResp>().data.allowed).toBe(true);
  });

  it('subject by email: admin checks on behalf of another user', async () => {
    const admin = await t.adminToken();
    const target = await t.ensureUser();
    await bind(target.principalId, 'subject:email', MASTER_TENANT_ID);

    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        tenantId: MASTER_TENANT_ID,
        scope: 'subject:email',
        subject: { email: target.email },
      },
    });
    expect(res.json<CheckResp>().data.allowed).toBe(true);
  });

  it('subject by apiKeyId: admin checks on behalf of an API key', async () => {
    const admin = await t.adminToken();
    const minted = await t.services.apiKeys.create({
      label: 'check-key',
      tenantId: MASTER_TENANT_ID,
    });
    await bind(minted.principalId, 'subject:key', MASTER_TENANT_ID);

    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        tenantId: MASTER_TENANT_ID,
        scope: 'subject:key',
        subject: { apiKeyId: minted.apiKey.id },
      },
    });
    expect(res.json<CheckResp>().data.allowed).toBe(true);
  });

  it('unknown subject resolves to allowed=false (not 404)', async () => {
    const admin = await t.adminToken();
    await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'whatever:read' });

    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        tenantId: MASTER_TENANT_ID,
        scope: 'whatever:read',
        subject: { email: 'nobody@example.com' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CheckResp>().data.allowed).toBe(false);
  });

  it('missing scope name resolves to allowed=false', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: MASTER_TENANT_ID, scope: 'no-such:scope' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CheckResp>().data.allowed).toBe(false);
  });

  it('multiple subject keys rejected by Zod (400)', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        tenantId: MASTER_TENANT_ID,
        scope: 'self:read',
        subject: { sub: 'a', email: 'b@b.com' },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 when subject provided but caller lacks permissions:check', async () => {
    const user = await t.ensureUser();
    const target = await t.ensureUser();
    await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'gated:read' });

    const res = await t.app.inject({
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        tenantId: MASTER_TENANT_ID,
        scope: 'gated:read',
        subject: { sub: target.sub },
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('inheritance: binding at parent grants the scope at descendant', async () => {
    const user = await t.ensureUser();
    const child = await t.services.tenants.create({
      name: 'inh-child',
      parentId: MASTER_TENANT_ID,
    });
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'r-inh',
      crossesBoundary: false,
    });
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'inh:read',
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
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: child.id, scope: 'inh:read' },
    });
    expect(res.json<CheckResp>().data.allowed).toBe(true);
  });

  // ──────────────────────────────────────────────────────────────────────
  // POST /check/batch
  // ──────────────────────────────────────────────────────────────────────

  it('batch returns results in input order with mixed true/false', async () => {
    const user = await t.ensureUser();
    await bind(user.principalId, 'batch:a', MASTER_TENANT_ID);
    // batch:b exists but unbound to user
    await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'batch:b' });

    const res = await t.app.inject({
      method: 'POST',
      url: '/check/batch',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        checks: [
          { tenantId: MASTER_TENANT_ID, scope: 'batch:a' },
          { tenantId: MASTER_TENANT_ID, scope: 'batch:b' },
          { tenantId: MASTER_TENANT_ID, scope: 'batch:a' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { results: { allowed: boolean }[] } }>();
    expect(body.data.results).toEqual([{ allowed: true }, { allowed: false }, { allowed: true }]);
  });

  it('batch allows mixed self-check + subject-check when caller has permissions:check', async () => {
    const admin = await t.adminToken();
    const target = await t.ensureUser();
    await bind(target.principalId, 'mix:subj', MASTER_TENANT_ID);

    const res = await t.app.inject({
      method: 'POST',
      url: '/check/batch',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        checks: [
          { tenantId: MASTER_TENANT_ID, scope: 'tenants:read' }, // self-check, admin has it
          { tenantId: MASTER_TENANT_ID, scope: 'mix:subj', subject: { sub: target.sub } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { results: { allowed: boolean }[] } }>();
    expect(body.data.results).toEqual([{ allowed: true }, { allowed: true }]);
  });

  it('batch 403 when caller lacks permissions:check for a subject-bearing entry', async () => {
    const user = await t.ensureUser();
    const target = await t.ensureUser();
    await t.services.scopes.create({ tenantId: MASTER_TENANT_ID, name: 'batch:gated' });

    const res = await t.app.inject({
      method: 'POST',
      url: '/check/batch',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        checks: [
          { tenantId: MASTER_TENANT_ID, scope: 'batch:gated', subject: { sub: target.sub } },
        ],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('batch 400 on empty checks array', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'POST',
      url: '/check/batch',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { checks: [] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('batch 400 when over 100 entries', async () => {
    const user = await t.ensureUser();
    const checks = Array.from({ length: 101 }, () => ({
      tenantId: MASTER_TENANT_ID,
      scope: 'irrelevant:scope',
    }));
    const res = await t.app.inject({
      method: 'POST',
      url: '/check/batch',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { checks },
    });
    expect(res.statusCode).toBe(400);
  });

  it('batch 400 on malformed entry (Zod path includes index)', async () => {
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'POST',
      url: '/check/batch',
      headers: { authorization: `Bearer ${user.token}` },
      payload: {
        checks: [
          { tenantId: MASTER_TENANT_ID, scope: 'ok:scope' },
          { tenantId: 'not-a-uuid', scope: 'broken' },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    // Type-provider surfaces JSON Pointer paths ('/checks/1/tenantId'); the
    // important thing is the index appears so callers can locate the bad entry.
    expect(body.error).toMatch(/checks[./]1/);
  });

  it('crossesBoundary spans inherit=false descendants', async () => {
    const user = await t.ensureUser();
    const blocked = await t.services.tenants.create({
      name: 'blocked',
      parentId: MASTER_TENANT_ID,
      inherit: false,
    });
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'r-cross',
      crossesBoundary: true,
    });
    const scope = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'cross:read',
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
      method: 'POST',
      url: '/check',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { tenantId: blocked.id, scope: 'cross:read' },
    });
    expect(res.json<CheckResp>().data.allowed).toBe(true);
  });
});
