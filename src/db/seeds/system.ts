import type { DbOrTx } from '../client.js';
import { roleScopes, roles, scopes, tenants } from '../schema.js';
import {
  MASTER_TENANT_ID,
  SYSTEM_ROLE_ADMIN_ID,
  SYSTEM_SCOPE_IDS,
  SYSTEM_SCOPE_NAMES,
} from './system-ids.js';

// Idempotent system seed. Safe to run multiple times against the same DB —
// rows are matched by their stable IDs (see ./system-ids.ts) and existing
// rows are left untouched. Called by:
//   - `npm run db:seed` (production / dev bootstrap)
//   - the integration-test reset helper in test/_helpers/db.ts
export async function seedSystemData(db: DbOrTx): Promise<void> {
  await db
    .insert(tenants)
    .values({
      id: MASTER_TENANT_ID,
      parentId: null,
      name: 'master',
      inherit: true,
    })
    .onConflictDoNothing({ target: tenants.id });

  await db
    .insert(scopes)
    .values([
      {
        id: SYSTEM_SCOPE_IDS.tenantsRead,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.tenantsRead,
        description: 'Read tenant rows and traverse the tenant hierarchy.',
      },
      {
        id: SYSTEM_SCOPE_IDS.tenantsWrite,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.tenantsWrite,
        description: 'Create, update, and delete tenants.',
      },
      {
        id: SYSTEM_SCOPE_IDS.rolesRead,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.rolesRead,
        description: 'Read roles and the scopes they bundle.',
      },
      {
        id: SYSTEM_SCOPE_IDS.rolesWrite,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.rolesWrite,
        description: 'Define and modify roles and their scope membership.',
      },
      {
        id: SYSTEM_SCOPE_IDS.apiKeysManage,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.apiKeysManage,
        description: 'Create, revoke, and inspect API keys.',
      },
      {
        id: SYSTEM_SCOPE_IDS.bindingsManage,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.bindingsManage,
        description: 'Grant and revoke role bindings on tenants.',
      },
      {
        id: SYSTEM_SCOPE_IDS.scopesRead,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.scopesRead,
        description: 'Read scope definitions on tenants.',
      },
      {
        id: SYSTEM_SCOPE_IDS.scopesWrite,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.scopesWrite,
        description: 'Create scope definitions on tenants.',
      },
      {
        id: SYSTEM_SCOPE_IDS.permissionsCheck,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.permissionsCheck,
        description: 'Call POST /check on behalf of other principals.',
      },
      {
        id: SYSTEM_SCOPE_IDS.outboxRead,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.outboxRead,
        description: 'List and inspect dead-letter outbox events.',
      },
      {
        id: SYSTEM_SCOPE_IDS.outboxWrite,
        tenantId: MASTER_TENANT_ID,
        name: SYSTEM_SCOPE_NAMES.outboxWrite,
        description: 'Revive or permanently delete dead-letter outbox events.',
      },
    ])
    .onConflictDoNothing({ target: scopes.id });

  await db
    .insert(roles)
    .values({
      id: SYSTEM_ROLE_ADMIN_ID,
      tenantId: MASTER_TENANT_ID,
      name: 'admin',
      description: 'Built-in super-role; holds every system scope. Crosses tenant boundaries.',
      crossesBoundary: true,
    })
    .onConflictDoNothing({ target: roles.id });

  await db
    .insert(roleScopes)
    .values(
      Object.values(SYSTEM_SCOPE_IDS).map((scopeId) => ({
        roleId: SYSTEM_ROLE_ADMIN_ID,
        scopeId,
      })),
    )
    .onConflictDoNothing();
}
