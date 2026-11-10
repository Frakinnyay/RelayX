import request from 'supertest';
import { signPayload } from '../../src/domain/signature';
import { createReceiverApp } from '../../src/receiver/app';

const SECRET = 'whsec_demo_local_secret';
const body = JSON.stringify({ id: 'evt1' });

function signed(ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return { 'X-RelayX-Event-Id': 'evt1', 'X-RelayX-Event-Type': 't', 'X-RelayX-Timestamp': String(ts), 'X-RelayX-Signature': signPayload(secret, ts, body), 'Content-Type': 'application/json' };
}

describe('receiver simulator', () => {
  it('healthy: verifies signature, returns 200, detects duplicates', async () => {
    const app = createReceiverApp({ secret: SECRET, hangMs: 10 });
    expect((await request(app).post('/webhook').set(signed()).send(body)).status).toBe(200);
    expect((await request(app).post('/webhook').set(signed()).send(body)).status).toBe(200);
    const state = await request(app).get('/control/state');
    expect(state.body.stats.duplicates).toBe(1);
    expect(state.body.uniqueEventsProcessed).toBe(1);
  });

  it('rejects a bad signature with 401', async () => {
    const app = createReceiverApp({ secret: SECRET, hangMs: 10 });
    const res = await request(app).post('/webhook').set(signed(undefined, 'wrong-secret')).send(body);
    expect(res.status).toBe(401);
  });

  it('failure mode cycles 500 -> timeout -> 500 -> 503, then heals', async () => {
    let now = 1_000_000;
    const app = createReceiverApp({ secret: SECRET, hangMs: 20, now: () => now });
    expect((await request(app).post('/control/fail').send({ seconds: 120 })).body.status).toBe('failing');
    expect((await request(app).post('/webhook').set(signed()).send(body)).status).toBe(500);
    expect((await request(app).post('/webhook').set(signed()).send(body)).status).toBe(504); // simulated hang, ends after hangMs
    expect((await request(app).post('/webhook').set(signed()).send(body)).status).toBe(500);
    expect((await request(app).post('/webhook').set(signed()).send(body)).status).toBe(503);
    now += 121_000; // failure window elapses
    expect((await request(app).get('/control/state')).body.status).toBe('healthy');
    expect((await request(app).post('/webhook').set(signed()).send(body)).status).toBe(200);
  });

  it('validates the fail duration', async () => {
    const app = createReceiverApp({ secret: SECRET, hangMs: 10 });
    expect((await request(app).post('/control/fail').send({ seconds: -5 })).status).toBe(400);
    expect((await request(app).post('/control/fail').send({})).status).toBe(400);
  });
});
