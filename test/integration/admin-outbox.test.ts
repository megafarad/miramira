import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable } from '../_helpers/db.js';
import { isFgaReachable } from '../_helpers/fga.js';
import { buildTestApp, type TestApp } from '../_helpers/app.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('routes: /admin/outbox/dead', () => {
  let t: TestApp;
  let outbox: OutboxRepository;

  beforeAll(async () => {
    t = await buildTestApp();
    outbox = new OutboxRepository(getTestDb().db);
  });
  beforeEach(async () => {
    await t.resetDb();
  });
  afterAll(async () => {
    await t.cleanup();
    await closeTestDb();
  });

  // Build N dead events directly via the repo so tests don't have to grind
  // the worker through maxAttempts retries.
  async function seedDead(count: number): Promise<string[]> {
    const { db } = getTestDb();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const evt = await db.transaction(async (tx) =>
        outbox.enqueue(tx, {
          aggregateType: 'tenant',
          aggregateId: MASTER_TENANT_ID,
          payload: { kind: 'tenant.created', tenantId: MASTER_TENANT_ID, parentId: null },
        }),
      );
      await outbox.markDead(evt.id, `final boom ${i}`);
      ids.push(evt.id);
    }
    return ids;
  }

  it('GET /admin/outbox/dead returns an empty page when nothing is dead', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/admin/outbox/dead',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: unknown[]; pageInfo: { nextCursor: string | null } }>();
    expect(body.data).toEqual([]);
    expect(body.pageInfo.nextCursor).toBeNull();
  });

  it('GET /admin/outbox/dead lists newest first and walks via cursor', async () => {
    const admin = await t.adminToken();
    const ids = await seedDead(3);

    const first = await t.app.inject({
      method: 'GET',
      url: '/admin/outbox/dead?limit=2',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json<{
      data: { id: string }[];
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>();
    expect(firstBody.data.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    expect(firstBody.pageInfo.hasMore).toBe(true);
    expect(firstBody.pageInfo.nextCursor).toBe(ids[1]);

    const second = await t.app.inject({
      method: 'GET',
      url: `/admin/outbox/dead?limit=2&cursor=${firstBody.pageInfo.nextCursor}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const secondBody = second.json<{
      data: { id: string }[];
      pageInfo: { nextCursor: string | null };
    }>();
    expect(secondBody.data.map((r) => r.id)).toEqual([ids[0]]);
    expect(secondBody.pageInfo.nextCursor).toBeNull();
  });

  it('GET /admin/outbox/dead/:id returns the event with its payload', async () => {
    const admin = await t.adminToken();
    const [id] = await seedDead(1);
    const res = await t.app.inject({
      method: 'GET',
      url: `/admin/outbox/dead/${id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; payload: { kind: string }; deadAt: string } }>();
    expect(body.data.id).toBe(id);
    expect(body.data.payload.kind).toBe('tenant.created');
    expect(body.data.deadAt).toBeTruthy();
  });

  it('GET /admin/outbox/dead/:id returns 404 for unknown / non-dead events', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'GET',
      url: '/admin/outbox/dead/00000000-0000-7000-8000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /admin/outbox/dead/:id/revive clears dead_at and re-delivers via worker', async () => {
    const admin = await t.adminToken();
    const ids = await seedDead(1);
    const id = ids[0]!;

    const res = await t.app.inject({
      method: 'POST',
      url: `/admin/outbox/dead/${id}/revive`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: { id: string; deadAt: string | null; attempts: number } }>();
    expect(body.data.deadAt).toBeNull();
    expect(body.data.attempts).toBe(0);

    // Worker now picks the event up and dispatches it successfully.
    const drain = await t.worker.runOnce();
    expect(drain.acked).toBeGreaterThan(0);
    // Row is gone from the dead list.
    expect(await outbox.getDead(id)).toBeNull();
  });

  it('POST /admin/outbox/dead/:id/revive returns 404 for unknown id', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/outbox/dead/00000000-0000-7000-8000-000000000000/revive',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /admin/outbox/dead/:id removes the row and returns 204', async () => {
    const admin = await t.adminToken();
    const ids = await seedDead(1);
    const id = ids[0]!;

    const res = await t.app.inject({
      method: 'DELETE',
      url: `/admin/outbox/dead/${id}`,
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(204);
    expect(await outbox.getDead(id)).toBeNull();
  });

  it('DELETE /admin/outbox/dead/:id returns 404 for unknown id', async () => {
    const admin = await t.adminToken();
    const res = await t.app.inject({
      method: 'DELETE',
      url: '/admin/outbox/dead/00000000-0000-7000-8000-000000000000',
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 for unauthenticated calls', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/admin/outbox/dead' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when the principal lacks outbox:read', async () => {
    // A vanilla user with no role bindings has no scopes.
    const user = await t.ensureUser();
    const res = await t.app.inject({
      method: 'GET',
      url: '/admin/outbox/dead',
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
