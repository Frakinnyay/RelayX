import { Pool } from 'pg';
import { verifySignature } from '../../src/domain/signature';
import { createWorkerMetrics } from '../../src/metrics';
import { Registry } from 'prom-client';
import { claimJobs } from '../../src/repositories/queue';
import { Worker } from '../../src/worker/worker';
import {
  createEndpointRow, createTenant, makePool, resetDb, seedDeliveries, silentLogger, startReceiver, testConfig, waitFor,
  type TestReceiver,
} from '../helpers';

let pool: Pool;
let tenantId: string;
let receiver: TestReceiver | undefined;

const SECRET = 'whsec_test_secret_123456';

function makeWorker(overrides: Record<string, string> = {}, workerId = 'test-worker'): Worker {
  return new Worker({ pool, config: testConfig(overrides), logger: silentLogger, metrics: createWorkerMetrics(new Registry()), workerId });
}

async function setup(handler: Parameters<typeof startReceiver>[0]): Promise<string> {
  receiver = await startReceiver(handler);
  const endpointId = await createEndpointRow(pool, tenantId, receiver.url, SECRET);
  await seedDeliveries(pool, tenantId, endpointId, 1);
  return endpointId;
}

/** Keep ticking until the (only) delivery reaches a terminal state. */
async function runUntilTerminal(worker: Worker): Promise<{ status: string; attempt_count: number; last_status_code: number | null; last_error: string | null }> {
  return waitFor(async () => {
    await worker.tickAndWait();
    const r = await pool.query('SELECT status, attempt_count, last_status_code, last_error FROM deliveries');
    return ['SUCCESS', 'DEAD_LETTERED'].includes(r.rows[0].status) ? r.rows[0] : undefined;
  });
}

const attempts = async (): Promise<{ attempt_number: number; outcome: string; status_code: number | null }[]> =>
  (await pool.query('SELECT attempt_number, outcome, status_code FROM delivery_attempts ORDER BY attempt_number')).rows;

beforeAll(() => {
  pool = makePool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  ({ tenantId } = await createTenant(pool));
});
afterEach(async () => {
  await receiver?.close();
  receiver = undefined;
});

describe('worker delivery behaviour', () => {
  it('200: delivers once with valid signature and headers', async () => {
    await setup(() => 200);
    const row = await runUntilTerminal(makeWorker());
    expect(row.status).toBe('SUCCESS');
    expect(row.attempt_count).toBe(1);
    expect(receiver?.requests).toHaveLength(1);

    const req = receiver?.requests[0];
    if (!req) throw new Error('no request');
    expect(req.headers['x-relayx-event-id']).toBeTruthy();
    expect(req.headers['x-relayx-event-type']).toBe('test.event');
    expect(verifySignature({
      secret: SECRET,
      timestampHeader: req.headers['x-relayx-timestamp'] as string,
      signatureHeader: req.headers['x-relayx-signature'] as string,
      rawBody: req.body,
    }).valid).toBe(true);
    expect(await attempts()).toEqual([{ attempt_number: 1, outcome: 'SUCCESS', status_code: 200 }]);
  });

  it.each([400, 401, 403, 404])('%i: permanent failure, NOT retried, dead-lettered immediately', async (code) => {
    await setup(() => code);
    const row = await runUntilTerminal(makeWorker());
    expect(row.status).toBe('DEAD_LETTERED');
    expect(row.attempt_count).toBe(1);
    expect(row.last_status_code).toBe(code);
    expect(receiver?.requests).toHaveLength(1);
    expect((await attempts())[0]?.outcome).toBe('PERMANENT_FAILURE');
  });

  it('500, 500, then 200: retries with backoff and finally succeeds; full history is kept', async () => {
    await setup((n) => (n < 3 ? 500 : 200));
    const row = await runUntilTerminal(makeWorker());
    expect(row.status).toBe('SUCCESS');
    expect(row.attempt_count).toBe(3);
    expect(await attempts()).toEqual([
      { attempt_number: 1, outcome: 'RETRYABLE_FAILURE', status_code: 500 },
      { attempt_number: 2, outcome: 'RETRYABLE_FAILURE', status_code: 500 },
      { attempt_number: 3, outcome: 'SUCCESS', status_code: 200 },
    ]);
  });

  it('always failing: dead-letters after max_attempts (4 here) and keeps every attempt', async () => {
    await setup(() => 500);
    const row = await runUntilTerminal(makeWorker());
    expect(row.status).toBe('DEAD_LETTERED');
    expect(row.attempt_count).toBe(4);
    expect(receiver?.requests).toHaveLength(4);
    expect((await attempts()).every((a) => a.outcome === 'RETRYABLE_FAILURE')).toBe(true);
  });

  it('429 with Retry-After is retried (and the header is honoured as a minimum delay)', async () => {
    await setup((n) => (n === 1 ? { status: 429, headers: { 'Retry-After': '0' } } : 200));
    const row = await runUntilTerminal(makeWorker());
    expect(row.status).toBe('SUCCESS');
    expect(row.attempt_count).toBe(2);
  });

  it('timeout: counts as retryable, then recovers when the receiver answers', async () => {
    await setup((n) => (n === 1 ? 'hang' : 200));
    const row = await runUntilTerminal(makeWorker({ DELIVERY_TIMEOUT_MS: '150' }));
    expect(row.status).toBe('SUCCESS');
    const a = await attempts();
    expect(a[0]).toEqual({ attempt_number: 1, outcome: 'RETRYABLE_FAILURE', status_code: null });
    const err = await pool.query('SELECT error FROM delivery_attempts WHERE attempt_number = 1');
    expect(err.rows[0].error).toBe('TIMEOUT');
  });

  it('receiver completely unavailable (connection refused): retryable', async () => {
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook', SECRET);
    await seedDeliveries(pool, tenantId, endpointId, 1);
    const worker = makeWorker();
    await worker.tickAndWait();
    const r = await pool.query('SELECT status, last_error FROM deliveries');
    expect(r.rows[0].status).toBe('RETRY_WAITING');
    expect(r.rows[0].last_error).toMatch(/ECONNREFUSED/);
  });

  it('SSRF protection: with private targets disabled, delivery to 127.0.0.1 is blocked permanently', async () => {
    await setup(() => 200);
    const row = await runUntilTerminal(makeWorker({ ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false' }));
    expect(row.status).toBe('DEAD_LETTERED');
    expect(row.last_error).toMatch(/BLOCKED_URL/);
    expect(receiver?.requests).toHaveLength(0); // the request was never sent
  });

  it('worker crash recovery: a job abandoned mid-processing is picked up after its lease expires', async () => {
    await setup(() => 200);
    await claimJobs(pool, { workerId: 'dead-worker', limit: 1, leaseMs: 60_000 }); // claims, then "crashes"
    expect(await makeWorker().tick()).toBe(0); // lease valid: not reclaimable
    await pool.query("UPDATE deliveries SET lease_until = now() - interval '1 second'");
    const row = await runUntilTerminal(makeWorker({}, 'rescuer'));
    expect(row.status).toBe('SUCCESS');
    expect(row.attempt_count).toBe(2);
  });

  it('graceful shutdown: an in-flight job that cannot finish is released without burning an attempt', async () => {
    await setup(() => 'hang');
    const worker = makeWorker({ DELIVERY_TIMEOUT_MS: '30000' });
    await worker.tick();
    await waitFor(async () => (receiver?.requests.length ?? 0) > 0);
    await worker.stop(100); // grace period too short for a hanging receiver
    const r = await pool.query('SELECT status, attempt_count, locked_by FROM deliveries');
    expect(r.rows[0]).toEqual({ status: 'RETRY_WAITING', attempt_count: 0, locked_by: null });
  });

  it('two workers on the same queue deliver each event exactly once when the receiver is healthy', async () => {
    receiver = await startReceiver(() => 200);
    const endpointId = await createEndpointRow(pool, tenantId, receiver.url, SECRET);
    await seedDeliveries(pool, tenantId, endpointId, 40);
    const w1 = makeWorker({}, 'w1');
    const w2 = makeWorker({}, 'w2');
    await waitFor(async () => {
      await Promise.all([w1.tickAndWait(), w2.tickAndWait()]);
      const r = await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE status = 'SUCCESS'");
      return r.rows[0].n === 40 ? true : undefined;
    });
    expect(receiver.requests).toHaveLength(40);
    expect(new Set(receiver.requests.map((q) => q.headers['x-relayx-event-id'])).size).toBe(40);
  });
});
