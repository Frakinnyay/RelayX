import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { Logger } from '../logger';

const LOCK_KEY = 727274; // arbitrary app-wide advisory lock id

export function defaultMigrationsDir(): string {
  return process.env.MIGRATIONS_DIR ?? path.resolve(__dirname, '../../../database/migrations');
}

/** Applies *.sql files in name order, once each, inside transactions. Safe to run from several processes. */
export async function runMigrations(pool: Pool, dir: string = defaultMigrationsDir(), logger?: Logger): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(file);
      logger?.info('migration_applied', { file });
    }
    return applied;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    } catch {
      /* connection may already be gone */
    }
    client.release();
  }
}
