import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/pool';

export interface AuthContext {
  tenantId: string;
  keyId: string;
  rateLimitPerMinute: number;
}

/** 192 bits of randomness. Because the key is high-entropy, a fast SHA-256 is sufficient (no bcrypt needed). */
export function generateApiKey(): string {
  return `rx_${randomBytes(24).toString('base64url')}`;
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export async function insertApiKey(db: Db, tenantId: string, rawKey: string): Promise<string> {
  const r = await db.query('INSERT INTO api_keys (tenant_id, key_prefix, key_hash) VALUES ($1, $2, $3) RETURNING id', [
    tenantId,
    rawKey.slice(0, 7),
    hashApiKey(rawKey),
  ]);
  return r.rows[0].id as string;
}

export async function findAuthByKeyHash(db: Db, keyHash: string): Promise<AuthContext | null> {
  const r = await db.query(
    `SELECT t.id AS tenant_id, k.id AS key_id, t.rate_limit_per_minute
       FROM api_keys k JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [keyHash],
  );
  const row = r.rows[0];
  if (!row) return null;
  return { tenantId: row.tenant_id, keyId: row.key_id, rateLimitPerMinute: row.rate_limit_per_minute };
}

export async function revokeApiKey(db: Db, keyId: string): Promise<void> {
  await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [keyId]);
}
