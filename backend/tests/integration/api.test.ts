import type { Express } from 'express';
import { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/api/app';
import { createWorkerMetrics } from '../../src/metrics';
import { Worker } from '../../src/worker/worker';
import { Registry } from 'prom-client';
import {
  ADMIN_TOKEN, createEndpointRow, createTenant, makePool, resetDb, silentLogger, startReceiver, testConfig, waitFor, type TestReceiver,
} from '../helpers';

let pool: Pool;
let app: Express;
const config = testConfig();

const auth = (key: string) => ({ Authorization: `Bearer ${key}` });
const eventBody = (endpointId: string, extra: Record<string, unknown> = {}) => ({
  eventType: 'order.created',
  endpointId,
  payload: { orderId: '123', amount: 1499 },
  ...extra,
});

beforeAll(() => {
  pool = makePool(20);
  app = createApp({ config, pool, logger: silentLogger, registry: new Registry() });
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
});

describe('authentication', () => {
  it('rejects missing, malformed and unknown keys with a consistent error body', async () => {
    for (const headers of [{}, { Authorization: 'Basic abc' }, auth('rx_not_a_real_key')]) {
      const res = await request(app).get('/api/v1/events').set(headers);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.body.error.requestId).toBeTruthy();
    }
  });

  it('tenant creation requires the admin token and returns the raw key once; only a hash is stored', async () => {
    expect((await request(app).post('/api/v1/tenants').send({ name: 'x' })).status).toBe(401);
    expect((await request(app).post('/api/v1/tenants').set('X-Admin-Token', 'wrong-token-wrong-token').send({ name: 'x' })).status).toBe(401);

    const res = await request(app).post('/api/v1/tenants').set('X-Admin-Token', ADMIN_TOKEN).send({ name: 'Acme' });
    expect(res.status).toBe(201);
    const key = res.body.apiKey as string;
    expect(key).toMatch(/^rx_/);

    const stored = await pool.query('SELECT key_hash, key_prefix FROM api_keys');
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows)).not.toContain(key); // raw key is nowhere in the database
    expect((await request(app).get('/api/v1/events').set(auth(key))).status).toBe(200);
  });

  it('rotation: the new key works, the old key stops working', async () => {
    const { apiKey } = await createTenant(pool);
    const res = await request(app).post('/api/v1/api-keys/rotate').set(auth(apiKey));
    expect(res.status).toBe(201);
    expect((await request(app).get('/api/v1/stats').set(auth(apiKey))).status).toBe(401);
    expect((await request(app).get('/api/v1/stats').set(auth(res.body.apiKey))).status).toBe(200);
  });
});

describe('endpoints and SSRF protection', () => {
  it('creates an endpoint, returns the secret once, and never returns it again', async () => {
    const { apiKey } = await createTenant(pool);
    const created = await request(app).post('/api/v1/endpoints').set(auth(apiKey)).send({ url: 'http://127.0.0.1:4000/webhook' });
    expect(created.status).toBe(201);
    expect(created.body.secret).toMatch(/^whsec_/);
    const list = await request(app).get('/api/v1/endpoints').set(auth(apiKey));
    expect(JSON.stringify(list.body)).not.toContain('secret');
  });

  it('with private targets disabled, rejects localhost, private IPs, metadata IP, http and credentials', async () => {
    const strict = createApp({ config: testConfig({ ALLOW_PRIVATE_WEBHOOK_TARGETS: 'false' }), pool, logger: silentLogger, registry: new Registry() });
    const { apiKey } = await createTenant(pool);
    for (const url of ['https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://169.254.169.254/latest', 'http://example.com/x', 'https://u:p@example.com/x']) {
      const res = await request(strict).post('/api/v1/endpoints').set(auth(apiKey)).send({ url });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_WEBHOOK_URL');
    }
    expect((await request(strict).post('/api/v1/endpoints').set(auth(apiKey)).send({ url: 'https://example.com/hook' })).status).toBe(201);
  });
});

describe('event ingestion', () => {
  it('accepts an event and creates a PENDING delivery', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    const res = await request(app).post('/api/v1/events').set(auth(apiKey)).send(eventBody(endpointId));
    expect(res.status).toBe(202);
    expect(res.body.idempotentReplay).toBe(false);
    expect(res.body.delivery.status).toBe('PENDING');
    expect(res.body.event.id).toBeTruthy();
  });

  it('validates the body with useful errors', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    const bad = [
      {},
      eventBody(endpointId, { eventType: 'bad type!' }),
      eventBody('not-a-uuid'),
      eventBody(endpointId, { payload: 'string' }),
      eventBody(endpointId, { unexpected: true }),
    ];
    for (const body of bad) {
      const res = await request(app).post('/api/v1/events').set(auth(apiKey)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    }
    const malformed = await request(app).post('/api/v1/events').set(auth(apiKey)).set('Content-Type', 'application/json').send('{oops');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_JSON');
  });

  it('does not leak internals: unknown routes and bad ids return clean errors', async () => {
    const { apiKey } = await createTenant(pool);
    const r404 = await request(app).get('/api/v1/nope').set(auth(apiKey));
    expect(r404.status).toBe(404);
    const rBadId = await request(app).get('/api/v1/events/not-a-uuid').set(auth(apiKey));
    expect(rBadId.status).toBe(400);
    expect(JSON.stringify(rBadId.body)).not.toMatch(/stack|node_modules|SELECT/i);
  });

  it('idempotency: same key returns the original event and creates nothing new', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    const body = eventBody(endpointId, { idempotencyKey: 'order-123-created' });
    const first = await request(app).post('/api/v1/events').set(auth(apiKey)).send(body);
    const second = await request(app).post('/api/v1/events').set(auth(apiKey)).send(body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.idempotentReplay).toBe(true);
    expect(second.body.event.id).toBe(first.body.event.id);
    expect(second.body.delivery.id).toBe(first.body.delivery.id);
    expect((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM deliveries')).rows[0].n).toBe(1);
  });

  it('idempotency via the Idempotency-Key header works too', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    const a = await request(app).post('/api/v1/events').set(auth(apiKey)).set('Idempotency-Key', 'k1').send(eventBody(endpointId));
    const b = await request(app).post('/api/v1/events').set(auth(apiKey)).set('Idempotency-Key', 'k1').send(eventBody(endpointId));
    expect(b.body.event.id).toBe(a.body.event.id);
  });

  it('idempotency: same key with a DIFFERENT body is a 409 conflict', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    await request(app).post('/api/v1/events').set(auth(apiKey)).send(eventBody(endpointId, { idempotencyKey: 'k' }));
    const res = await request(app).post('/api/v1/events').set(auth(apiKey)).send(eventBody(endpointId, { idempotencyKey: 'k', payload: { different: true } }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('idempotency under concurrency: 25 simultaneous identical requests create exactly one event', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    const body = eventBody(endpointId, { idempotencyKey: 'race' });
    const responses = await Promise.all(Array.from({ length: 25 }, () => request(app).post('/api/v1/events').set(auth(apiKey)).send(body)));
    expect(responses.every((r) => r.status === 200 || r.status === 202)).toBe(true);
    expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
    expect(new Set(responses.map((r) => r.body.event.id)).size).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM events')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM deliveries')).rows[0].n).toBe(1);
  });

  it('the same idempotency key in two different tenants creates two events', async () => {
    const a = await createTenant(pool, 'a');
    const b = await createTenant(pool, 'b');
    const epA = await createEndpointRow(pool, a.tenantId, 'http://127.0.0.1:1/hook');
    const epB = await createEndpointRow(pool, b.tenantId, 'http://127.0.0.1:1/hook');
    const ra = await request(app).post('/api/v1/events').set(auth(a.apiKey)).send(eventBody(epA, { idempotencyKey: 'same' }));
    const rb = await request(app).post('/api/v1/events').set(auth(b.apiKey)).send(eventBody(epB, { idempotencyKey: 'same' }));
    expect(ra.body.event.id).not.toBe(rb.body.event.id);
  });
});

describe('tenant isolation', () => {
  it('tenant B cannot use, read, or replay tenant A\'s resources', async () => {
    const a = await createTenant(pool, 'a');
    const b = await createTenant(pool, 'b');
    const epA = await createEndpointRow(pool, a.tenantId, 'http://127.0.0.1:1/hook');
    const ev = await request(app).post('/api/v1/events').set(auth(a.apiKey)).send(eventBody(epA));

    const useEndpoint = await request(app).post('/api/v1/events').set(auth(b.apiKey)).send(eventBody(epA));
    expect(useEndpoint.status).toBe(400);
    expect(useEndpoint.body.error.code).toBe('ENDPOINT_NOT_FOUND');

    expect((await request(app).get(`/api/v1/events/${ev.body.event.id}`).set(auth(b.apiKey))).status).toBe(404);
    expect((await request(app).get(`/api/v1/deliveries/${ev.body.delivery.id}`).set(auth(b.apiKey))).status).toBe(404);
    expect((await request(app).post(`/api/v1/deliveries/${ev.body.delivery.id}/replay`).set(auth(b.apiKey))).status).toBe(404);
    expect((await request(app).get(`/api/v1/endpoints/${epA}`).set(auth(b.apiKey))).status).toBe(404);
    expect((await request(app).get('/api/v1/events').set(auth(b.apiKey))).body.data).toHaveLength(0);
    expect((await request(app).get('/api/v1/deliveries').set(auth(b.apiKey))).body.data).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  it('rejects requests over the per-tenant limit with 429 + Retry-After, and is safe under concurrency', async () => {
    const { apiKey, tenantId } = await createTenant(pool, 'limited', 5);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => request(app).post('/api/v1/events').set(auth(apiKey)).send(eventBody(endpointId, { idempotencyKey: `rl-${i}` }))),
    );
    const accepted = responses.filter((r) => r.status === 202);
    const limited = responses.filter((r) => r.status === 429);
    // Each one-minute window may accept at most 5. (A burst can straddle a minute boundary, so group by window.)
    const perWindow = new Map<string, number>();
    for (const r of accepted) perWindow.set(String(r.headers['x-ratelimit-reset']), (perWindow.get(String(r.headers['x-ratelimit-reset'])) ?? 0) + 1);
    for (const n of perWindow.values()) expect(n).toBeLessThanOrEqual(5);
    expect(accepted.length + limited.length).toBe(20);
    expect(limited.length).toBeGreaterThanOrEqual(10);
    expect(limited[0]?.headers['retry-after']).toBeTruthy();
    expect(limited[0]?.body.error.code).toBe('RATE_LIMITED');
    expect(limited[0]?.headers['x-ratelimit-limit']).toBe('5');
  });

  it('limits are per tenant: one tenant being limited does not affect another', async () => {
    const a = await createTenant(pool, 'a', 1);
    const b = await createTenant(pool, 'b', 100);
    const epA = await createEndpointRow(pool, a.tenantId, 'http://127.0.0.1:1/hook');
    const epB = await createEndpointRow(pool, b.tenantId, 'http://127.0.0.1:1/hook');
    await request(app).post('/api/v1/events').set(auth(a.apiKey)).send(eventBody(epA));
    expect((await request(app).post('/api/v1/events').set(auth(a.apiKey)).send(eventBody(epA))).status).toBe(429);
    expect((await request(app).post('/api/v1/events').set(auth(b.apiKey)).send(eventBody(epB))).status).toBe(202);
  });
});

describe('replay and dead-letter flow (end to end through the worker)', () => {
  let receiver: TestReceiver | undefined;
  afterEach(async () => {
    await receiver?.close();
    receiver = undefined;
  });

  it('dead-letters on 400, then replay creates a NEW delivery that succeeds; original history is untouched', async () => {
    let mode = 400;
    receiver = await startReceiver(() => mode);
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, receiver.url);
    const worker = new Worker({ pool, config, logger: silentLogger, metrics: createWorkerMetrics(new Registry()), workerId: 'api-test-worker' });

    const ev = await request(app).post('/api/v1/events').set(auth(apiKey)).send(eventBody(endpointId));
    const deliveryId = ev.body.delivery.id as string;
    await waitFor(async () => {
      await worker.tickAndWait();
      return (await pool.query('SELECT status FROM deliveries WHERE id = $1', [deliveryId])).rows[0].status === 'DEAD_LETTERED';
    });

    const dlq = await request(app).get('/api/v1/deliveries?status=DEAD_LETTERED').set(auth(apiKey));
    expect(dlq.body.data).toHaveLength(1);

    mode = 200; // receiver is fixed
    const replay = await request(app).post(`/api/v1/deliveries/${deliveryId}/replay`).set(auth(apiKey));
    expect(replay.status).toBe(202);
    expect(replay.body.id).not.toBe(deliveryId);
    expect(replay.body.replayOf).toBe(deliveryId);
    await waitFor(async () => {
      await worker.tickAndWait();
      return (await pool.query('SELECT status FROM deliveries WHERE id = $1', [replay.body.id])).rows[0].status === 'SUCCESS';
    });

    const detail = await request(app).get(`/api/v1/events/${ev.body.event.id}`).set(auth(apiKey));
    expect(detail.body.deliveries).toHaveLength(2);
    const original = detail.body.deliveries.find((d: { id: string }) => d.id === deliveryId);
    expect(original.status).toBe('DEAD_LETTERED');
    expect(original.attempts).toHaveLength(1);
    expect(original.attempts[0].statusCode).toBe(400);
    // same event id both times => the receiver can de-duplicate (at-least-once)
    expect(receiver.requests).toHaveLength(2);
    expect(receiver.requests[0]?.headers['x-relayx-event-id']).toBe(receiver.requests[1]?.headers['x-relayx-event-id']);
  });

  it('replay is refused (409) while a delivery is still in flight', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    const ev = await request(app).post('/api/v1/events').set(auth(apiKey)).send(eventBody(endpointId));
    const res = await request(app).post(`/api/v1/deliveries/${ev.body.delivery.id}/replay`).set(auth(apiKey));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
  });
});

describe('operational endpoints', () => {
  it('/health reports database status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('/health returns 503 when the database is unreachable', async () => {
    const broken = new Pool({ connectionString: 'postgres://nobody:nope@127.0.0.1:1/none', max: 1, connectionTimeoutMillis: 300 });
    broken.on('error', () => undefined);
    const brokenApp = createApp({ config, pool: broken, logger: silentLogger, registry: new Registry() });
    const res = await request(brokenApp).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    await broken.end();
  });

  it('/metrics exposes Prometheus metrics including queue depth and event counters', async () => {
    const { apiKey, tenantId } = await createTenant(pool);
    const endpointId = await createEndpointRow(pool, tenantId, 'http://127.0.0.1:1/hook');
    await request(app).post('/api/v1/events').set(auth(apiKey)).send(eventBody(endpointId));
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('relayx_events_received_total');
    expect(res.text).toMatch(/relayx_queue_depth\{status="PENDING"\} 1/);
  });

  it('/openapi.json is served', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.body.openapi).toBe('3.0.3');
  });
});
