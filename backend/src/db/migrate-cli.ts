import { createLogger } from '../logger';
import { createPool } from './pool';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const logger = createLogger('info');
  const pool = createPool(url, 2, logger);
  try {
    const applied = await runMigrations(pool, undefined, logger);
    logger.info('migrations_complete', { applied });
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Migration failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
