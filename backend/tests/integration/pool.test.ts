import request from 'supertest';
import { Pool } from 'pg';
import { Registry } from 'prom-client';
import { createApp } from '../../src/api/app';
import { createEndpointRow, createTenant, makePool, resetDb, silentLogger, testConfig, TEST_DB_URL } from '../helpers';

// Regression test for a real bug found with k6: duplicate-key requests asked the pool for a SECOND connection
// while holding the first, so many simultaneous duplicates exhausted the pool and timed out.
describe('connection pool safety under concurrent duplicate requests', () => {
  let adminPool: Pool;
  let smallPool: Pool;

  beforeAll(() => {
    adminPool = makePool();
    smallPool = new Pool({ connectionString: TEST_DB_URL, max: 3, connectionTimeoutMillis: 3000 });
  });
  afterAll(async () => {
    await smallPool.end();
    await adminPool.end();
  });
  beforeEach(async () => {
    await resetDb(adminPool);
  });

  it('100 simultaneous identical requests on a 3-connection pool all succeed and create exactly one event', async () => {
    const { apiKey, tenantId } = await createTenant(adminPool);
    const endpointId = await createEndpointRow(adminPool, tenantId, 'http://127.0.0.1:1/hook');
    const app = createApp({ config: testConfig(), pool: smallPool, logger: silentLogger, registry: new Registry() });
    const body = { eventType: 'order.created', endpointId, payload: { a: 1 }, idempotencyKey: 'pool-test' };

    const responses = await Promise.all(
      Array.from({ length: 100 }, () => request(app).post('/api/v1/events').set('Authorization', `Bearer ${apiKey}`).send(body)),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s !== 200 && s !== 202)).toEqual([]); // no 500s
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    expect((await adminPool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(1);
  });
});
