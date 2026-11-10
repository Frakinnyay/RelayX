import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_VERSION = 'v1';

/**
 * Canonical signed message:  `${timestampSeconds}.${rawRequestBody}`
 * Header value:              `v1=<hex HMAC-SHA256(secret, message)>`
 */
export function signPayload(secret: string, timestampSec: number, rawBody: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `${SIGNATURE_VERSION}=${mac}`;
}

export interface VerifyInput {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  toleranceSec?: number;
  nowSec?: number;
}

export interface VerifyResult {
  valid: boolean;
  reason?: 'MISSING_HEADERS' | 'BAD_TIMESTAMP' | 'TIMESTAMP_OUT_OF_TOLERANCE' | 'SIGNATURE_MISMATCH';
}

/** Receiver-side verification: constant-time compare + timestamp tolerance (replay protection). */
export function verifySignature(input: VerifyInput): VerifyResult {
  const { secret, timestampHeader, signatureHeader, rawBody } = input;
  const tolerance = input.toleranceSec ?? 300;
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (!timestampHeader || !signatureHeader) return { valid: false, reason: 'MISSING_HEADERS' };
  if (!/^\d+$/.test(timestampHeader)) return { valid: false, reason: 'BAD_TIMESTAMP' };
  const ts = Number(timestampHeader);
  if (Math.abs(now - ts) > tolerance) return { valid: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };
  const expected = Buffer.from(signPayload(secret, ts, rawBody));
  const given = Buffer.from(signatureHeader);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { valid: false, reason: 'SIGNATURE_MISMATCH' };
  }
  return { valid: true };
}
