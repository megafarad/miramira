import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Runtime migration runner. Uses drizzle-orm's built-in migrator so it has
// no dependency on drizzle-kit — runnable from the production Docker image
// where devDependencies are absent. Generate migrations locally with
// `npm run db:generate`; apply them anywhere with `npm run db:migrate:apply`.

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to apply migrations.');
  process.exit(1);
}

// Folder is relative to process.cwd(); the container copies src/db/migrations
// in alongside dist/, the dev workflow runs from the repo root either way.
const migrationsFolder = process.env.MIGRATIONS_FOLDER ?? './src/db/migrations';

async function main(): Promise<void> {
  const sql = postgres(databaseUrl!, { max: 1 });
  const db = drizzle({ client: sql });
  try {
    console.log(`Applying migrations from ${migrationsFolder}...`);
    await migrate(db, { migrationsFolder });
    console.log('Migrations applied.');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
