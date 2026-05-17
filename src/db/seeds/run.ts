import { existsSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { seedSystemData } from './system.js';
import { MASTER_TENANT_ID, SYSTEM_ROLE_ADMIN_ID } from './system-ids.js';
import { UsersRepository } from '../../repositories/users.js';
import { PrincipalsRepository } from '../../repositories/principals.js';
import { RoleBindingsServiceImpl } from '../../services/role-bindings.js';
import { roleBindings } from '../schema.js';
import type { Database } from '../client.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is required to run the seed script. ' +
      'Copy .env.example to .env or export DATABASE_URL in your shell.',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const sql = postgres(databaseUrl!, { max: 1 });
  const db = drizzle({ client: sql });
  try {
    await seedSystemData(db);
    console.log('System seed applied.');

    const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
    if (adminEmail) {
      await bootstrapAdmin(db, adminEmail);
    } else {
      console.log(
        'BOOTSTRAP_ADMIN_EMAIL not set; no admin binding created. ' +
          'API requests will 403 until at least one principal holds the admin role.',
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Upsert the named user, ensure their principal row, and bind the system admin
// role at the master tenant if no active binding already exists. Idempotent.
// The binding fires a role_binding.created outbox event; running `npm run worker`
// once afterward materializes the FGA tuples so the user can call the API.
async function bootstrapAdmin(db: Database, email: string): Promise<void> {
  const users = new UsersRepository(db);
  const principals = new PrincipalsRepository(db);
  const user = await users.upsertByEmailId(email);
  const principal = await principals.ensureForUser(user.id);

  const existing = await db
    .select({ id: roleBindings.id })
    .from(roleBindings)
    .where(
      and(
        eq(roleBindings.principalId, principal.id),
        eq(roleBindings.roleId, SYSTEM_ROLE_ADMIN_ID),
        eq(roleBindings.tenantId, MASTER_TENANT_ID),
        isNull(roleBindings.revokedAt),
      ),
    )
    .limit(1);
  if (existing.length > 0) {
    console.log(
      `Bootstrap admin: active binding already exists for ${email} (principal ${principal.id}).`,
    );
    return;
  }

  const bindings = new RoleBindingsServiceImpl({ db });
  const binding = await bindings.create({
    principalId: principal.id,
    roleId: SYSTEM_ROLE_ADMIN_ID,
    tenantId: MASTER_TENANT_ID,
  });
  console.log(
    `Bootstrap admin: created binding ${binding.id} for ${email} (principal ${principal.id}). ` +
      'Run `npm run worker` to materialize FGA tuples.',
  );
}

main().catch((err: unknown) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
