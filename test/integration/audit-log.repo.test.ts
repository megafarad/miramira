import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { AuditLogRepository, type NewAuditEntry } from '../../src/repositories/audit-log.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

function fixture(overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    actorPrincipalId: null,
    actorKind: null,
    requestId: 'req-default',
    method: 'POST',
    route: '/test',
    action: 'tenant.create',
    targetType: 'tenant',
    targetId: null,
    tenantId: null,
    before: null,
    after: null,
    ip: '127.0.0.1',
    userAgent: 'test',
    ...overrides,
  };
}

describe.skipIf(!(await isDbReachable()))('AuditLogRepository.page', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('returns rows newest-first by id', async () => {
    const { db } = getTestDb();
    const repo = new AuditLogRepository(db);
    const first = await repo.insert(fixture({ requestId: 'r1' }));
    const second = await repo.insert(fixture({ requestId: 'r2' }));
    const third = await repo.insert(fixture({ requestId: 'r3' }));

    const page = await repo.page({}, { limit: 50 });
    // UUIDv7 ids increase with creation time → DESC puts newest first.
    expect(page.items.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
    expect(page.nextCursor).toBeNull();
  });

  it('cursors across the full set', async () => {
    const { db } = getTestDb();
    const repo = new AuditLogRepository(db);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await repo.insert(fixture({ requestId: `r${i}` }))).id);
    }

    const first = await repo.page({}, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1]?.id);

    const second = await repo.page({}, { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBe(second.items[1]?.id);

    const third = await repo.page({}, { limit: 2, cursor: second.nextCursor ?? undefined });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    // Concatenating pages equals the unpaginated list.
    const all = [...first.items, ...second.items, ...third.items].map((r) => r.id);
    expect(all).toEqual(ids.slice().reverse());
  });

  it('filters by actorPrincipalId, targetType, targetId, action, tenantId, requestId', async () => {
    const { db } = getTestDb();
    const repo = new AuditLogRepository(db);
    // Create a real principal so the actor_principal_id FK is satisfied.
    const user = await new UsersRepository(db).upsertByEmailId('actor@x');
    const actor = (await new PrincipalsRepository(db).ensureForUser(user.id)).id;
    const targetA = '019e2e5d-3ef7-777c-962e-50e26e4d3da3';
    const targetB = '019e2e5d-3ef7-777c-962e-50e26e4d4444';

    await repo.insert(
      fixture({
        actorPrincipalId: null,
        targetType: 'tenant',
        targetId: targetA,
        action: 'tenant.create',
        tenantId: MASTER_TENANT_ID,
        requestId: 'req-A',
      }),
    );
    await repo.insert(
      fixture({
        actorPrincipalId: actor,
        actorKind: 'user',
        targetType: 'user',
        targetId: targetB,
        action: 'user.disable',
        tenantId: null,
        requestId: 'req-B',
      }),
    );
    await repo.insert(
      fixture({
        actorPrincipalId: actor,
        actorKind: 'user',
        targetType: 'tenant',
        targetId: targetA,
        action: 'tenant.update',
        tenantId: MASTER_TENANT_ID,
        requestId: 'req-C',
      }),
    );

    // actor → 2 hits
    expect((await repo.page({ actorPrincipalId: actor }, { limit: 50 })).items).toHaveLength(2);
    // targetType → 2 hits (tenant rows)
    expect((await repo.page({ targetType: 'tenant' }, { limit: 50 })).items).toHaveLength(2);
    // targetId + targetType → 2 hits (composite-index match)
    expect(
      (await repo.page({ targetType: 'tenant', targetId: targetA }, { limit: 50 })).items,
    ).toHaveLength(2);
    // action → 1 hit
    expect((await repo.page({ action: 'user.disable' }, { limit: 50 })).items).toHaveLength(1);
    // tenantId → 2 hits
    expect((await repo.page({ tenantId: MASTER_TENANT_ID }, { limit: 50 })).items).toHaveLength(2);
    // requestId → 1 hit
    expect((await repo.page({ requestId: 'req-B' }, { limit: 50 })).items).toHaveLength(1);
    // AND-composed: actor + targetType → 1 hit
    expect(
      (await repo.page({ actorPrincipalId: actor, targetType: 'user' }, { limit: 50 })).items,
    ).toHaveLength(1);
  });

  it('filters by createdAt range via since/until', async () => {
    const { db } = getTestDb();
    const repo = new AuditLogRepository(db);
    const r1 = await repo.insert(fixture({ requestId: 'r-old' }));
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await repo.insert(fixture({ requestId: 'r-new' }));
    expect(r2.createdAt.getTime()).toBeGreaterThan(r1.createdAt.getTime());

    // PG stores microsecond-resolution timestamps but JS Date round-trips
    // through millisecond resolution, so a cutoff *exactly* on a row's
    // createdAt can miss it on the upper-bound side. Use a midpoint to
    // sidestep the boundary entirely.
    const midpoint = new Date((r1.createdAt.getTime() + r2.createdAt.getTime()) / 2);

    const after = await repo.page({ since: midpoint }, { limit: 50 });
    expect(after.items.map((r) => r.requestId)).toEqual(['r-new']);

    const before = await repo.page({ until: midpoint }, { limit: 50 });
    expect(before.items.map((r) => r.requestId)).toEqual(['r-old']);
  });

  it('findById returns the row by id and undefined for unknown', async () => {
    const { db } = getTestDb();
    const repo = new AuditLogRepository(db);
    const row = await repo.insert(fixture());
    expect((await repo.findById(row.id))?.id).toBe(row.id);
    expect(await repo.findById('00000000-0000-7000-8000-000000000000')).toBeUndefined();
  });
});
