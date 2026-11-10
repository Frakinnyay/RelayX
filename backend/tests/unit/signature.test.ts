import { signPayload, verifySignature } from '../../src/domain/signature';

const body = '{"id":"evt_1","data":{"amount":1499}}';
const ts = 1_700_000_000;

describe('HMAC signatures', () => {
  const sig = signPayload('secret', ts, body);

  it('has the documented format', () => expect(sig).toMatch(/^v1=[0-9a-f]{64}$/));

  it('verifies a correct signature', () => {
    expect(verifySignature({ secret: 'secret', timestampHeader: String(ts), signatureHeader: sig, rawBody: body, nowSec: ts + 5 }).valid).toBe(true);
  });

  it('rejects a wrong secret, a modified body, and a modified timestamp', () => {
    const base = { timestampHeader: String(ts), signatureHeader: sig, nowSec: ts };
    expect(verifySignature({ ...base, secret: 'other', rawBody: body }).reason).toBe('SIGNATURE_MISMATCH');
    expect(verifySignature({ ...base, secret: 'secret', rawBody: body + ' ' }).reason).toBe('SIGNATURE_MISMATCH');
    expect(verifySignature({ ...base, secret: 'secret', rawBody: body, timestampHeader: String(ts + 1) }).reason).toBe('SIGNATURE_MISMATCH');
  });

  it('rejects stale timestamps (replay protection)', () => {
    const r = verifySignature({ secret: 'secret', timestampHeader: String(ts), signatureHeader: sig, rawBody: body, nowSec: ts + 301 });
    expect(r).toEqual({ valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
  });

  it('rejects missing or malformed headers without throwing', () => {
    expect(verifySignature({ secret: 's', timestampHeader: undefined, signatureHeader: sig, rawBody: body }).reason).toBe('MISSING_HEADERS');
    expect(verifySignature({ secret: 's', timestampHeader: 'abc', signatureHeader: sig, rawBody: body }).reason).toBe('BAD_TIMESTAMP');
    expect(verifySignature({ secret: 'secret', timestampHeader: String(ts), signatureHeader: 'short', rawBody: body, nowSec: ts }).valid).toBe(false);
  });
});
