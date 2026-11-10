import type { Db } from '../db/pool';

export interface RateLimitResult {
  count: number;
  windowEndsAtMs: number;
}

/**
 * Fixed-window counter, atomic under concurrency: INSERT ... ON CONFLICT DO UPDATE takes a row lock,
 * so concurrent requests are serialised on the (tenant, window) row and each sees a distinct count.
 * Window = the current wall-clock minute according to the DATABASE clock (all API nodes agree).
 */
export async function hit(db: Db, tenantId: string): Promise<RateLimitResult> {
  const r = await db.query(
    `INSERT INTO rate_limit_buckets (tenant_id, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / 60) * 60), 1)
     ON CONFLICT (tenant_id, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
     RETURNING count, extract(epoch FROM window_start)::float8 AS window_epoch`,
    [tenantId],
  );
  const row = r.rows[0];
  return { count: row.count as number, windowEndsAtMs: ((row.window_epoch as number) + 60) * 1000 };
}

export async function purgeOldBuckets(db: Db): Promise<void> {
  await db.query("DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 hour'");
}
