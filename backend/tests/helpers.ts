import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { loadConfig, type Config } from '../src/config';
import { createLogger } from '../src/logger';
import { DEFAULT_TEST_DB } from './globalSetup';
import { generateApiKey, insertApiKey } from '../src/repositories/apiKeys';
import { insertTenant } from '../src/repositories/tenants';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DB;
export const ADMIN_TOKEN = 'test-admin-token-1234567890';
export const silentLogger = createLogger('silent');

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DB_URL,
    ADMIN_TOKEN,
    ALLOW_PRIVATE_WEBHOOK_TARGETS: 'true',
    RETRY_BASE_DELAY_MS: '20',
    RETRY_FACTOR: '2',
    RETRY_MAX_DELAY_MS: '100',
    RETRY_JITTER: '0.1',
    MAX_ATTEMPTS: '4',
    DELIVERY_TIMEOUT_MS: '300',
    LEASE_DURATION_MS: '60000',
    WORKER_CONCURRENCY: '5',
    ...overrides,
  });
}

export function makePool(max = 10): Pool {
  return new Pool({ connectionString: TEST_DB_URL, max });
}

export async function resetDb(pool: Pool): Promise<void> {
  // CASCADE removes api_keys, endpoints, events, deliveries, attempts and rate-limit rows.
  await pool.query('TRUNCATE tenants CASCADE');
}

export async function createTenant(pool: Pool, name = 'acme', rateLimit = 1000): Promise<{ tenantId: string; apiKey: string }> {
  const tenant = await insertTenant(pool, name, rateLimit);
  const apiKey = generateApiKey();
  await insertApiKey(pool, tenant.id, apiKey);
  return { tenantId: tenant.id, apiKey };
}

export async function createEndpointRow(pool: Pool, tenantId: string, url: string, secret = 'whsec_test_secret_123456'): Promise<string> {
  const r = await pool.query('INSERT INTO webhook_endpoints (tenant_id, url, secret) VALUES ($1, $2, $3) RETURNING id', [tenantId, url, secret]);
  return r.rows[0].id as string;
}

/** Inserts N PENDING deliveries (with their events) in one statement. */
export async function seedDeliveries(pool: Pool, tenantId: string, endpointId: string, n: number, maxAttempts = 4): Promise<void> {
  await pool.query(
    `WITH ev AS (
       INSERT INTO events (tenant_id, endpoint_id, event_type, payload, request_hash)
       SELECT $1, $2, 'test.event', '{}'::jsonb, md5(g::text) FROM generate_series(1, $3::int) g
       RETURNING id)
     INSERT INTO deliveries (tenant_id, event_id, endpoint_id, max_attempts)
     SELECT $1, id, $2, $4 FROM ev`,
    [tenantId, endpointId, n, maxAttempts],
  );
}

export interface TestReceiver {
  url: string;
  requests: { headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

/** Tiny HTTP server whose response is decided by `handler` (return a status code, or 'hang'). */
export async function startReceiver(
  handler: (n: number, headers: http.IncomingHttpHeaders) => number | 'hang' | { status: number; headers: Record<string, string> },
): Promise<TestReceiver> {
  const requests: TestReceiver['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const result = handler(requests.length, req.headers);
      if (result === 'hang') return; // never respond
      if (typeof result === 'number') res.writeHead(result).end();
      else res.writeHead(result.status, result.headers).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 10_000, intervalMs = 25): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
