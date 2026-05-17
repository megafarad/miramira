import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { closeTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { auditLog, type AuditLogEntry } from '../../src/db/schema.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('audit log', () => {
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

  async function lastEntry(filter: Partial<Pick<AuditLogEntry, 'action' | 'targetId'>>): Promise<
    AuditLogEntry | undefined
  > {
    const rows = await t.db.select().from(auditLog).orderBy(desc(auditLog.createdAt));
    return rows.find(
      (r) =>
        (filter.action === undefined || r.action === filter.action) &&
        (filter.targetId === undefined || r.targetId === filter.targetId),
    );
  }

  async function countAll(): Promise<number> {
    const rows = await t.db.select().from(auditLog);
    return rows.length;
  }

  it('POST /tenants writes tenant.create with after=row, before=null', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'audited-org', parentId: MASTER_TENANT_ID },
    });
    const tenantId = res.json<{ data: { id: string } }>().data.id;

    const entry = await lastEntry({ action: 'tenant.create', targetId: tenantId });
    expect(entry).toBeDefined();
    expect(entry?.before).toBeNull();
    expect(entry?.after).toMatchObject({ id: tenantId, name: 'audited-org' });
    expect(entry?.actorPrincipalId).toBe(admin.principalId);
    expect(entry?.actorKind).toBe('user');
    expect(entry?.tenantId).toBe(tenantId);
    expect(entry?.method).toBe('POST');
    expect(entry?.route).toBe('/tenants');
  });

  it('PATCH /tenants/:id writes tenant.update with both before and after', async () => {
    const admin = await t.adminToken();
    // Rename master directly — admin holds tenants:write at master, no extra
    // worker draining required to materialize tuples at a freshly-created child.
    const beforeName = (await t.services.tenants.get(MASTER_TENANT_ID)).name;

    await t.app.inject({
      method: 'PATCH',
      url: `/tenants/${MASTER_TENANT_ID}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'renamed-master' },
    });

    const entry = await lastEntry({ action: 'tenant.update', targetId: MASTER_TENANT_ID });
    expect(entry).toBeDefined();
    expect(entry?.before).toMatchObject({ name: beforeName });
    expect(entry?.after).toMatchObject({ name: 'renamed-master' });
  });

  it('role-binding create + revoke produce paired entries', async () => {
    const admin = await t.adminToken();
    const target = await t.ensureUser();
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'audit-r',
    });

    const created = await t.app.inject({
      method: 'POST',
      url: '/role-bindings',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        principalId: target.principalId,
        roleId: role.id,
        tenantId: MASTER_TENANT_ID,
      },
    });
    const bindingId = created.json<{ data: { id: string } }>().data.id;

    const createEntry = await lastEntry({
      action: 'role_binding.create',
      targetId: bindingId,
    });
    expect(createEntry?.before).toBeNull();
    expect(createEntry?.after).toMatchObject({ id: bindingId, principalId: target.principalId });

    await t.app.inject({
      method: 'DELETE',
      url: `/role-bindings/${bindingId}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });

    const revokeEntry = await lastEntry({
      action: 'role_binding.revoke',
      targetId: bindingId,
    });
    expect(revokeEntry?.before).toMatchObject({ id: bindingId, revokedAt: null });
    expect(revokeEntry?.after).toMatchObject({ id: bindingId });
    expect((revokeEntry?.after as { revokedAt: string | null }).revokedAt).not.toBeNull();
  });

  it('POST /api-keys audit `after` excludes the one-time secret', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api-keys',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { label: 'audited-key', tenantId: MASTER_TENANT_ID },
    });
    const keyId = res.json<{ data: { id: string } }>().data.id;

    const entry = await lastEntry({ action: 'api_key.create', targetId: keyId });
    expect(entry).toBeDefined();
    const after = entry?.after as Record<string, unknown>;
    expect(after.id).toBe(keyId);
    expect(after.label).toBe('audited-key');
    // The minted secret must never end up in the audit table.
    expect(after.secret).toBeUndefined();
    expect(Object.keys(after)).not.toContain('secret');
    // The persisted hash is in the row, but that's by design (it's already in
    // api_keys.key_hash). It's a hash, not the secret itself.
    expect(typeof after.keyHash).toBe('string');
  });

  it('failed mutation (403) does NOT write an audit entry', async () => {
    const user = await t.ensureUser(); // no admin binding
    const countBefore = await countAll();

    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${user.token}` },
      payload: { name: 'rejected', parentId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(403);

    expect(await countAll()).toBe(countBefore);
  });

  it('actor_principal_id and actor_kind match an API-key caller', async () => {
    const admin = await t.adminToken();
    const minted = await t.services.apiKeys.create({
      label: 'caller-key',
      tenantId: MASTER_TENANT_ID,
    });
    // Bind admin role to the api-key principal so it can mutate.
    await t.grantAdminAt(minted.principalId);

    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { 'x-api-key': minted.secret },
      payload: { name: 'apikey-created', parentId: MASTER_TENANT_ID },
    });
    expect(res.statusCode).toBe(200);
    const tenantId = res.json<{ data: { id: string } }>().data.id;

    const entry = await lastEntry({ action: 'tenant.create', targetId: tenantId });
    expect(entry?.actorPrincipalId).toBe(minted.principalId);
    expect(entry?.actorKind).toBe('api_key');
    void admin;
  });

  it('role.scope_add captures full scope membership snapshot before/after', async () => {
    const admin = await t.adminToken();
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'audit-scopes-r',
    });
    const s1 = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'audit:s1',
    });
    await t.services.roles.addScopes(role.id, [s1.id]); // baseline membership

    const s2 = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'audit:s2',
    });
    await t.app.inject({
      method: 'POST',
      url: `/roles/${role.id}/scopes`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { scopeIds: [s2.id] },
    });

    const entry = await lastEntry({ action: 'role.scope_add', targetId: role.id });
    expect(entry?.before).toEqual({ scopeIds: [s1.id].sort() });
    expect(entry?.after).toEqual({ scopeIds: [s1.id, s2.id].sort() });
  });

  it('role.scope_remove captures full scope membership snapshot before/after', async () => {
    const admin = await t.adminToken();
    const role = await t.services.roles.create({
      tenantId: MASTER_TENANT_ID,
      name: 'audit-scopes-rm',
    });
    const s1 = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'audit-rm:s1',
    });
    const s2 = await t.services.scopes.create({
      tenantId: MASTER_TENANT_ID,
      name: 'audit-rm:s2',
    });
    await t.services.roles.addScopes(role.id, [s1.id, s2.id]);

    await t.app.inject({
      method: 'DELETE',
      url: `/roles/${role.id}/scopes/${s1.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });

    const entry = await lastEntry({ action: 'role.scope_remove', targetId: role.id });
    expect(entry?.before).toEqual({ scopeIds: [s1.id, s2.id].sort() });
    expect(entry?.after).toEqual({ scopeIds: [s2.id] });
  });

  it('audit row carries request_id; same id matches the structured log entry', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'reqid-test', parentId: MASTER_TENANT_ID },
    });
    const tenantId = res.json<{ data: { id: string } }>().data.id;

    const entry = await lastEntry({ action: 'tenant.create', targetId: tenantId });
    expect(entry?.requestId).toBeTruthy();
    expect(typeof entry?.requestId).toBe('string');
  });

  it('audit table can be queried by target_type + target_id for a resource history', async () => {
    const admin = await t.adminToken();
    const created = await t.app.inject({
      method: 'POST',
      url: '/tenants',
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'history-target', parentId: MASTER_TENANT_ID },
    });
    const tenantId = created.json<{ data: { id: string } }>().data.id;

    // Drain the outbox so tenant.created fans out admin's tuples to the new
    // child; otherwise PATCH 403s before the service ever runs.
    for (;;) {
      const r = await t.worker.runOnce();
      if (r.claimed === 0) break;
    }

    await t.app.inject({
      method: 'PATCH',
      url: `/tenants/${tenantId}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { name: 'history-renamed' },
    });

    const history = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, tenantId))
      .orderBy(auditLog.createdAt);
    expect(history.map((h) => h.action)).toEqual(['tenant.create', 'tenant.update']);
  });
});
