import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, getTestDb, isDbReachable, resetDb } from '../_helpers/db.js';
import { createTestFga, isFgaReachable } from '../_helpers/fga.js';
import type { FgaClient } from '../../src/openfga/client.js';
import { OutboxRepository } from '../../src/repositories/outbox.js';
import { TenantsServiceImpl } from '../../src/services/tenants.js';
import { RoleBindingsServiceImpl } from '../../src/services/role-bindings.js';
import { GrantMaterializerImpl } from '../../src/services/grant-materializer.js';
import { RolesRepository } from '../../src/repositories/roles.js';
import { ScopesRepository } from '../../src/repositories/scopes.js';
import { UsersRepository } from '../../src/repositories/users.js';
import { PrincipalsRepository } from '../../src/repositories/principals.js';
import { OutboxDispatcherImpl } from '../../src/workers/dispatcher.js';
import { OutboxWorker } from '../../src/workers/worker.js';
import { principalObject, scopeGrantObject } from '../../src/openfga/tuples.js';
import { MASTER_TENANT_ID } from '../../src/db/seeds/system-ids.js';

const reachable = (await isDbReachable()) && (await isFgaReachable());

describe.skipIf(!reachable)('OutboxWorker (end-to-end)', () => {
  let fga: FgaClient;
  let cleanupFga: () => Promise<void>;
  let worker: OutboxWorker;
  let outbox: OutboxRepository;
  let tenants: TenantsServiceImpl;
  let bindings: RoleBindingsServiceImpl;
  let rolesRepo: RolesRepository;
  let scopesRepo: ScopesRepository;
  let users: UsersRepository;
  let principals: PrincipalsRepository;

  beforeAll(async () => {
    const ctx = await createTestFga();
    fga = ctx.client;
    cleanupFga = ctx.cleanup;
    const { db } = getTestDb();
    outbox = new OutboxRepository(db);
    const materializer = new GrantMaterializerImpl({ db, fga });
    const dispatcher = new OutboxDispatcherImpl({ materializer });
    worker = new OutboxWorker({ outbox, dispatcher });
    tenants = new TenantsServiceImpl({ db });
    bindings = new RoleBindingsServiceImpl({ db });
    rolesRepo = new RolesRepository(db);
    scopesRepo = new ScopesRepository(db);
    users = new UsersRepository(db);
    principals = new PrincipalsRepository(db);
  });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await cleanupFga();
    await closeTestDb();
  });

  async function makeUserPrincipal(email: string): Promise<string> {
    const u = await users.upsertByEmailId(email);
    return (await principals.ensureForUser(u.id)).id;
  }

  it('processes a role_binding.created event end-to-end and acks it', async () => {
    const principalId = await makeUserPrincipal('e2e@example.com');
    const org = await tenants.create({ name: 'org', parentId: MASTER_TENANT_ID });
    const scope = await scopesRepo.create({ tenantId: org.id, name: 'docs:read' });
    const role = await rolesRepo.create({ tenantId: org.id, name: 'reader' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    await bindings.create({ principalId, roleId: role.id, tenantId: org.id });

    // Drain whatever's pending (tenant.created + role_binding.created)
    const result = await worker.runOnce();
    expect(result.failed).toBe(0);
    expect(result.acked).toBeGreaterThan(0);

    expect(
      await fga.check({
        user: principalObject(principalId),
        relation: 'granted',
        object: scopeGrantObject(org.id, scope.id),
      }),
    ).toBe(true);

    const pending = await outbox.listPending();
    expect(pending).toHaveLength(0);
  });

  it('revoke event removes the FGA tuple via the worker', async () => {
    const principalId = await makeUserPrincipal('e2e-rev@example.com');
    const org = await tenants.create({ name: 'org', parentId: MASTER_TENANT_ID });
    const scope = await scopesRepo.create({ tenantId: org.id, name: 'docs:read' });
    const role = await rolesRepo.create({ tenantId: org.id, name: 'reader' });
    await rolesRepo.addScopes(role.id, [scope.id]);
    const binding = await bindings.create({ principalId, roleId: role.id, tenantId: org.id });
    await worker.runOnce();
    expect(
      await fga.check({
        user: principalObject(principalId),
        relation: 'granted',
        object: scopeGrantObject(org.id, scope.id),
      }),
    ).toBe(true);

    await bindings.revoke(binding.id);
    await worker.runOnce();

    expect(
      await fga.check({
        user: principalObject(principalId),
        relation: 'granted',
        object: scopeGrantObject(org.id, scope.id),
      }),
    ).toBe(false);
  });

  it('records a failure with future next_retry_at when delivery throws', async () => {
    const { db } = getTestDb();
    // Build a worker whose materializer always throws.
    const angryMaterializer = {
      materializeBindingCreated: async (): Promise<void> => {
        throw new Error('simulated downstream failure');
      },
      materializeBindingRevoked: async (): Promise<void> => undefined,
      materializeTenantCreated: async (): Promise<void> => undefined,
      materializeRoleScopeAdded: async (): Promise<void> => undefined,
      materializeRoleScopeRemoved: async (): Promise<void> => undefined,
    };
    const angryDispatcher = new OutboxDispatcherImpl({ materializer: angryMaterializer });
    const angryWorker = new OutboxWorker({ outbox, dispatcher: angryDispatcher });

    const principalId = await makeUserPrincipal('angry@example.com');
    const role = await rolesRepo.create({ tenantId: MASTER_TENANT_ID, name: 'angry-reader' });
    await bindings.create({ principalId, roleId: role.id, tenantId: MASTER_TENANT_ID });

    const result = await angryWorker.runOnce();
    expect(result.failed).toBeGreaterThan(0);

    // The event is still pending but should have a future next_retry_at
    // (claimBatch only returns rows whose retry time has elapsed).
    const stillPending = await new OutboxRepository(db).listPending();
    expect(stillPending).toHaveLength(0); // not yet eligible to retry
  });
});
