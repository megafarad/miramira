import { describe, expect, it, vi } from 'vitest';
import { OutboxDispatcherImpl } from '../../src/workers/dispatcher.js';
import type { GrantMaterializer } from '../../src/services/grant-materializer.js';
import type { OutboxEvent } from '../../src/db/schema.js';

function event(payload: object): OutboxEvent {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    aggregateType: 'role_binding',
    aggregateId: '00000000-0000-7000-8000-000000000002',
    eventType: (payload as { kind: string }).kind,
    payload,
    createdAt: new Date(),
    processedAt: null,
    attempts: 0,
    lastError: null,
    nextRetryAt: new Date(),
    deadAt: null,
    updatedAt: new Date(),
  };
}

interface Spies {
  materializer: GrantMaterializer;
  created: ReturnType<typeof vi.fn>;
  revoked: ReturnType<typeof vi.fn>;
  tenantCreated: ReturnType<typeof vi.fn>;
  scopeAdded: ReturnType<typeof vi.fn>;
  scopeRemoved: ReturnType<typeof vi.fn>;
}

function makeMaterializerSpy(): Spies {
  const created = vi.fn();
  const revoked = vi.fn();
  const tenantCreated = vi.fn();
  const scopeAdded = vi.fn();
  const scopeRemoved = vi.fn();
  return {
    materializer: {
      materializeBindingCreated: created,
      materializeBindingRevoked: revoked,
      materializeTenantCreated: tenantCreated,
      materializeRoleScopeAdded: scopeAdded,
      materializeRoleScopeRemoved: scopeRemoved,
    },
    created,
    revoked,
    tenantCreated,
    scopeAdded,
    scopeRemoved,
  };
}

describe('OutboxDispatcher', () => {
  it('routes role_binding.created to materializeBindingCreated', async () => {
    const { materializer, created, revoked } = makeMaterializerSpy();
    const d = new OutboxDispatcherImpl({ materializer });
    await d.handle(event({ kind: 'role_binding.created', bindingId: 'b1' }));
    expect(created).toHaveBeenCalledWith('b1');
    expect(revoked).not.toHaveBeenCalled();
  });

  it('routes role_binding.revoked to materializeBindingRevoked', async () => {
    const { materializer, revoked } = makeMaterializerSpy();
    const d = new OutboxDispatcherImpl({ materializer });
    await d.handle(event({ kind: 'role_binding.revoked', bindingId: 'b1' }));
    expect(revoked).toHaveBeenCalledWith('b1');
  });

  it('routes tenant.created to materializeTenantCreated', async () => {
    const { materializer, tenantCreated } = makeMaterializerSpy();
    const d = new OutboxDispatcherImpl({ materializer });
    await d.handle(event({ kind: 'tenant.created', tenantId: 't1', parentId: null }));
    expect(tenantCreated).toHaveBeenCalledWith('t1');
  });

  it('routes role.scope_added to materializeRoleScopeAdded', async () => {
    const { materializer, scopeAdded } = makeMaterializerSpy();
    const d = new OutboxDispatcherImpl({ materializer });
    await d.handle(event({ kind: 'role.scope_added', roleId: 'r1', scopeId: 's1' }));
    expect(scopeAdded).toHaveBeenCalledWith('r1', 's1');
  });

  it('routes role.scope_removed to materializeRoleScopeRemoved', async () => {
    const { materializer, scopeRemoved } = makeMaterializerSpy();
    const d = new OutboxDispatcherImpl({ materializer });
    await d.handle(event({ kind: 'role.scope_removed', roleId: 'r1', scopeId: 's1' }));
    expect(scopeRemoved).toHaveBeenCalledWith('r1', 's1');
  });

  it('no-ops tenant.parent_changed without throwing', async () => {
    const { materializer, tenantCreated } = makeMaterializerSpy();
    const d = new OutboxDispatcherImpl({ materializer });
    await expect(
      d.handle(event({ kind: 'tenant.parent_changed', tenantId: 't', parentId: 'p' })),
    ).resolves.toBeUndefined();
    expect(tenantCreated).not.toHaveBeenCalled();
  });

  it('logs but does not throw on an unknown kind', async () => {
    const { materializer } = makeMaterializerSpy();
    const warn = vi.fn();
    const d = new OutboxDispatcherImpl({ materializer, logger: { warn } });
    await expect(d.handle(event({ kind: 'something.future' }))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
