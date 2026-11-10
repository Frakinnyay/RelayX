import { computeRequestHash } from '../../src/domain/idempotency';
import { generateApiKey, hashApiKey } from '../../src/repositories/apiKeys';

const base = { eventType: 'order.created', endpointId: 'e1', payload: { orderId: '1' }, metadata: {} };

describe('request hash (idempotency conflict detection)', () => {
  it('is stable for identical requests', () => expect(computeRequestHash(base)).toBe(computeRequestHash({ ...base })));
  it('changes when payload, type or endpoint change', () => {
    const h = computeRequestHash(base);
    expect(computeRequestHash({ ...base, payload: { orderId: '2' } })).not.toBe(h);
    expect(computeRequestHash({ ...base, eventType: 'order.paid' })).not.toBe(h);
    expect(computeRequestHash({ ...base, endpointId: 'e2' })).not.toBe(h);
  });
});

describe('api key generation/hashing', () => {
  it('generates unique high-entropy keys with a recognisable prefix', () => {
    const a = generateApiKey();
    expect(a).toMatch(/^rx_[A-Za-z0-9_-]{32}$/);
    expect(generateApiKey()).not.toBe(a);
  });
  it('hash is deterministic, hex, and never equals the raw key', () => {
    const k = generateApiKey();
    expect(hashApiKey(k)).toBe(hashApiKey(k));
    expect(hashApiKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(k)).not.toContain(k);
  });
});
