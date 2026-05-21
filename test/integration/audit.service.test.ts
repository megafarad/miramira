import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { AuditServiceImpl } from '../../src/services/audit.js';
import { AuditLogRepository } from '../../src/repositories/audit-log.js';
import { NotFoundError } from '../../src/services/errors.js';

describe.skipIf(!(await isDbReachable()))('AuditService', () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('get returns the row by id', async () => {
    const { db } = getTestDb();
    const repo = new AuditLogRepository(db);
    const service = new AuditServiceImpl({ db });
    const row = await repo.insert({
      actorPrincipalId: null,
      actorKind: null,
      requestId: 'rq',
      method: 'GET',
      route: '/x',
      action: 'tenant.create',
      targetType: 'tenant',
      targetId: null,
      tenantId: null,
      before: null,
      after: null,
      ip: null,
      userAgent: null,
    });
    expect((await service.get(row.id)).id).toBe(row.id);
  });

  it('get throws NotFoundError for unknown id', async () => {
    const { db } = getTestDb();
    const service = new AuditServiceImpl({ db });
    await expect(service.get('00000000-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('page passes through to the repo', async () => {
    const { db } = getTestDb();
    const repo = new AuditLogRepository(db);
    const service = new AuditServiceImpl({ db });
    await repo.insert({
      actorPrincipalId: null,
      actorKind: null,
      requestId: 'pass-1',
      method: 'POST',
      route: '/y',
      action: 'role.create',
      targetType: 'role',
      targetId: null,
      tenantId: null,
      before: null,
      after: null,
      ip: null,
      userAgent: null,
    });
    const page = await service.page({ action: 'role.create' }, { limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.requestId).toBe('pass-1');
  });
});
