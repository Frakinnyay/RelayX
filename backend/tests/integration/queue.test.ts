import { Pool } from 'pg';
import { claimJobs, finishAttempt } from '../../src/repositories/queue';
import { createEndpointRow, createTenant, makePool, resetDb, seedDeliveries, TEST_DB_URL } from '../helpers';

let pool: Pool;
let tenantId: string;
let endpointId: string;

beforeAll(() => {
  pool = makePool();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  ({ tenantId } = await createTenant(pool));
  endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:9/hook');
});

describe('PostgreSQL queue: FOR UPDATE SKIP LOCKED', () => {
  it('many concurrent workers never claim the same job twice and together claim every job', async () => {
    const TOTAL = 200;
    await seedDeliveries(pool, tenantId, endpointId, TOTAL);

    // 10 workers, each with its OWN connection, all claiming in parallel.
    const pools = Array.from({ length: 10 }, () => new Pool({ connectionString: TEST_DB_URL, max: 1 }));
    try {
      const perWorker = await Promise.all(
        pools.map(async (p, i) => {
          const mine: string[] = [];
          for (;;) {
            const jobs = await claimJobs(p, { workerId: `w${i}`, limit: 7, leaseMs: 60_000 });
            if (jobs.length === 0) break;
            mine.push(...jobs.map((j) => j.id));
          }
          return mine;
        }),
      );
      const all = perWorker.flat();
      expect(all).toHaveLength(TOTAL);
      expect(new Set(all).size).toBe(TOTAL); // no duplicates
      const stuck = await pool.query("SELECT count(*)::int AS n FROM deliveries WHERE status <> 'PROCESSING' OR attempt_count <> 1");
      expect(stuck.rows[0].n).toBe(0); // every row claimed exactly once
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('SKIP LOCKED: a row locked by another open transaction is skipped, not waited on', async () => {
    await seedDeliveries(pool, tenantId, endpointId, 1);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT id FROM deliveries WHERE status = 'PENDING' FOR UPDATE"); // "worker A" holds the row lock
      const started = Date.now();
      const claimedByB = await claimJobs(pool, { workerId: 'B', limit: 5, leaseMs: 60_000 });
      expect(claimedByB).toHaveLength(0);
      expect(Date.now() - started).toBeLessThan(2000); // returned immediately instead of blocking
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    const claimedAfter = await claimJobs(pool, { workerId: 'B', limit: 5, leaseMs: 60_000 });
    expect(claimedAfter).toHaveLength(1);
  });

  it('does not claim jobs that are not yet due', async () => {
    await seedDeliveries(pool, tenantId, endpointId, 1);
    await pool.query("UPDATE deliveries SET next_attempt_at = now() + interval '1 hour'");
    expect(await claimJobs(pool, { workerId: 'w', limit: 5, leaseMs: 60_000 })).toHaveLength(0);
  });

  it('stuck-job recovery: an expired lease makes the job claimable by another worker', async () => {
    await seedDeliveries(pool, tenantId, endpointId, 1);
    const [first] = await claimJobs(pool, { workerId: 'crashed-worker', limit: 1, leaseMs: 60_000 });
    expect(first?.attemptCount).toBe(1);

    // lease still valid -> nobody else can take it
    expect(await claimJobs(pool, { workerId: 'other', limit: 1, leaseMs: 60_000 })).toHaveLength(0);

    // simulate the crash: the lease runs out
    await pool.query("UPDATE deliveries SET lease_until = now() - interval '1 second'");
    const [second] = await claimJobs(pool, { workerId: 'other', limit: 1, leaseMs: 60_000 });
    expect(second?.id).toBe(first?.id);
    expect(second?.attemptCount).toBe(2);
  });

  it('fencing: a worker that lost its lease cannot overwrite the new owner\'s result', async () => {
    await seedDeliveries(pool, tenantId, endpointId, 1);
    const [stale] = await claimJobs(pool, { workerId: 'stale', limit: 1, leaseMs: 60_000 });
    await pool.query("UPDATE deliveries SET lease_until = now() - interval '1 second'");
    const [fresh] = await claimJobs(pool, { workerId: 'fresh', limit: 1, leaseMs: 60_000 });
    if (!stale || !fresh) throw new Error('setup failed');

    const attempt = { outcome: 'SUCCESS' as const, statusCode: 200, error: null, durationMs: 5, startedAt: new Date(), workerId: 'x' };
    expect(await finishAttempt(pool, stale, 'stale', attempt, { type: 'success' })).toBe(false);
    expect(await finishAttempt(pool, fresh, 'fresh', { ...attempt, workerId: 'fresh' }, { type: 'success' })).toBe(true);

    const row = await pool.query('SELECT status FROM deliveries WHERE id = $1', [fresh.id]);
    expect(row.rows[0].status).toBe('SUCCESS');
    const attempts = await pool.query('SELECT count(*)::int AS n FROM delivery_attempts WHERE delivery_id = $1', [fresh.id]);
    expect(attempts.rows[0].n).toBe(1); // the stale worker wrote nothing
  });
});
