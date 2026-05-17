// Stable IDs for the rows produced by `npm run db:seed`. Treat as constants;
// changing them after the seed has run in any environment requires a manual
// data migration.
//
// Repository and service code can import these to reference the master tenant
// or built-in scopes/roles without a runtime lookup. The seed script (see
// ./system.ts) inserts rows with these exact IDs and is idempotent.

export const MASTER_TENANT_ID = '019e2e5d-3ef7-777c-962e-50e26e4d3da3';

export const SYSTEM_ROLE_ADMIN_ID = '019e2e5d-3ef8-75ad-85c6-b28fded51022';

export const SYSTEM_SCOPE_IDS = {
  tenantsRead: '019e2e5d-3ef8-75ad-85c6-b6dc1132be09',
  tenantsWrite: '019e2e5d-3ef8-75ad-85c6-b9f714b84f19',
  rolesRead: '019e2e5d-3ef8-75ad-85c6-bf108aa5de13',
  rolesWrite: '019e2e5d-3ef8-75ad-85c6-c12fa6120a81',
  apiKeysManage: '019e2e5d-3ef8-75ad-85c6-c445d6415e02',
  bindingsManage: '019e2e5d-3ef8-75ad-85c6-c85e4b9e2cf4',
  scopesRead: '019e2e5d-3ef8-75ad-85c6-cb71d3a5f1a8',
  scopesWrite: '019e2e5d-3ef8-75ad-85c6-cd824a987b34',
  permissionsCheck: '019e2e5d-3ef8-75ad-85c6-d09a3e8211c5',
} as const;

export const SYSTEM_SCOPE_NAMES = {
  tenantsRead: 'tenants:read',
  tenantsWrite: 'tenants:write',
  rolesRead: 'roles:read',
  rolesWrite: 'roles:write',
  apiKeysManage: 'api_keys:manage',
  bindingsManage: 'bindings:manage',
  scopesRead: 'scopes:read',
  scopesWrite: 'scopes:write',
  permissionsCheck: 'permissions:check',
} as const;
