import type { Pool } from 'pg';
import { generateApiKey, insertApiKey, revokeApiKey, type AuthContext } from '../repositories/apiKeys';
import { insertTenant, type Tenant } from '../repositories/tenants';

/** The raw key is returned exactly once, here. Only its hash is persisted. */
export async function createTenantWithKey(pool: Pool, name: string, rateLimitPerMinute: number): Promise<{ tenant: Tenant; apiKey: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await insertTenant(client, name, rateLimitPerMinute);
    const apiKey = generateApiKey();
    await insertApiKey(client, tenant.id, apiKey);
    await client.query('COMMIT');
    return { tenant, apiKey };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Issues a new key and revokes the key that made the request, atomically. */
export async function rotateKey(pool: Pool, auth: AuthContext): Promise<{ apiKey: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const apiKey = generateApiKey();
    await insertApiKey(client, auth.tenantId, apiKey);
    await revokeApiKey(client, auth.keyId);
    await client.query('COMMIT');
    return { apiKey };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
