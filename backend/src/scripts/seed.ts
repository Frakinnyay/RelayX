import { hashApiKey, insertApiKey } from '../repositories/apiKeys';
import { createPool } from '../db/pool';
import { createLogger } from '../logger';

/**
 * Local demo data: one tenant, one known API key, one endpoint pointing at the receiver simulator.
 * Idempotent. Refuses to run in production unless SEED_ALLOW=true (the demo key is public knowledge).
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  if (process.env.NODE_ENV === 'production' && process.env.SEED_ALLOW !== 'true') {
    throw new Error('Refusing to seed in production (set SEED_ALLOW=true to override)');
  }
  const apiKey = process.env.SEED_API_KEY ?? 'rx_demo_local_key_0123456789abcdef';
  const receiverUrl = process.env.SEED_RECEIVER_URL ?? 'http://localhost:4000/webhook';
  const secret = process.env.SEED_ENDPOINT_SECRET ?? 'whsec_demo_local_secret';
  const logger = createLogger('info');
  const pool = createPool(url, 2, logger);
  try {
    const exists = await pool.query('SELECT 1 FROM api_keys WHERE key_hash = $1', [hashApiKey(apiKey)]);
    if (exists.rowCount) {
      logger.info('seed_skipped_already_present');
      return;
    }
    const t = await pool.query("INSERT INTO tenants (name, rate_limit_per_minute) VALUES ('demo', 100000) RETURNING id");
    const tenantId = t.rows[0].id as string;
    await insertApiKey(pool, tenantId, apiKey);
    const ep = await pool.query(
      "INSERT INTO webhook_endpoints (tenant_id, url, description, secret) VALUES ($1, $2, 'Demo receiver simulator', $3) RETURNING id",
      [tenantId, receiverUrl, secret],
    );
    logger.info('seed_complete', { tenantId, endpointId: ep.rows[0].id, apiKey, receiverUrl });
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
