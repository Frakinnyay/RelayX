import { Pool } from 'pg';
import { runMigrations } from '../src/db/migrate';

export const DEFAULT_TEST_DB = 'postgres://relayx:relayx@localhost:5433/relayx_test';

/** Creates the test database if missing, then applies migrations. Needs a reachable PostgreSQL server. */
export default async function globalSetup(): Promise<void> {
  const url = new URL(process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DB);
  const dbName = url.pathname.slice(1);
  if (!/^[a-z0-9_]+$/i.test(dbName)) throw new Error(`Unsafe test database name: ${dbName}`);
  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const adminPool = new Pool({ connectionString: admin.toString(), max: 1 });
  try {
    const exists = await adminPool.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rowCount) await adminPool.query(`CREATE DATABASE ${dbName}`);
  } catch (err) {
    throw new Error(
      `Cannot reach PostgreSQL for integration tests (${admin.host}). Start it with "docker compose up -d postgres". Cause: ${(err as Error).message}`,
    );
  } finally {
    await adminPool.end();
  }
  const pool = new Pool({ connectionString: url.toString(), max: 1 });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
