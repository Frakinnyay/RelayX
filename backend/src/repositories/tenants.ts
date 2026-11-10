import type { Db } from '../db/pool';
import { camelize } from '../util/camel';

export interface Tenant {
  id: string;
  name: string;
  rateLimitPerMinute: number;
  createdAt: Date;
}

export async function insertTenant(db: Db, name: string, rateLimitPerMinute: number): Promise<Tenant> {
  const r = await db.query('INSERT INTO tenants (name, rate_limit_per_minute) VALUES ($1, $2) RETURNING *', [
    name,
    rateLimitPerMinute,
  ]);
  return camelize(r.rows[0]);
}
