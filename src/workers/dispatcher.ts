import type { OutboxEvent } from '../db/schema.js';
import type { GrantMaterializer } from '../services/grant-materializer.js';
import type { OutboxPayload } from '../repositories/outbox.js';

export interface OutboxDispatcher {
  handle(event: OutboxEvent): Promise<void>;
}

export interface DispatcherLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface DispatcherDeps {
  materializer: GrantMaterializer;
  logger?: DispatcherLogger;
}

export class OutboxDispatcherImpl implements OutboxDispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  async handle(event: OutboxEvent): Promise<void> {
    const payload = event.payload as OutboxPayload;
    switch (payload.kind) {
      case 'role_binding.created':
        await this.deps.materializer.materializeBindingCreated(payload.bindingId);
        return;
      case 'role_binding.revoked':
        await this.deps.materializer.materializeBindingRevoked(payload.bindingId);
        return;
      case 'tenant.created':
        await this.deps.materializer.materializeTenantCreated(payload.tenantId);
        return;
      case 'role.scope_added':
        await this.deps.materializer.materializeRoleScopeAdded(payload.roleId, payload.scopeId);
        return;
      case 'role.scope_removed':
        await this.deps.materializer.materializeRoleScopeRemoved(payload.roleId, payload.scopeId);
        return;
      case 'tenant.parent_changed':
        // Still a no-op until we add the tenant update service that emits it
        // with both oldParentId and the new one. See Phase 6+1.
        return;
      default:
        // Unknown kind: log and ack. Don't block the queue on something we
        // don't understand — a future deploy probably knows what to do.
        this.deps.logger?.warn(
          { eventId: event.id, kind: (payload as { kind: string }).kind },
          'unknown outbox event kind; acking without processing',
        );
    }
  }
}
