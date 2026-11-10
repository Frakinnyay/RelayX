import type { Pool } from 'pg';
import type { Db } from '../db/pool';
import type { AttemptOutcome } from '../domain/classify';
import { assertTransition } from '../domain/state';

export interface ClaimedJob {
  id: string;
  tenantId: string;
  eventId: string;
  endpointId: string;
  attemptCount: number; // already incremented: this is the number of the attempt about to run
  maxAttempts: number;
}

/**
 * Atomically claim up to `limit` due jobs.
 *
 * The inner SELECT ... FOR UPDATE SKIP LOCKED locks the candidate rows and silently skips rows that other
 * workers' transactions have locked, so two workers can never receive the same row. The outer UPDATE (same
 * statement, same transaction) flips them to PROCESSING and stamps a lease.
 *
 * Second branch of the WHERE clause = stuck-job recovery: a PROCESSING row whose lease expired (worker died)
 * becomes claimable again.
 */
export async function claimJobs(db: Db, p: { workerId: string; limit: number; leaseMs: number }): Promise<ClaimedJob[]> {
  assertTransition('PENDING', 'PROCESSING');
  const r = await db.query(
    `WITH picked AS (
       SELECT id FROM deliveries
        WHERE (status IN ('PENDING','RETRY_WAITING') AND next_attempt_at <= now())
           OR (status = 'PROCESSING' AND lease_until < now())
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE deliveries d
        SET status = 'PROCESSING',
            locked_by = $2,
            locked_at = now(),
            lease_until = now() + make_interval(secs => $3::double precision),
            attempt_count = d.attempt_count + 1,
            updated_at = now()
       FROM picked
      WHERE d.id = picked.id
      RETURNING d.id, d.tenant_id, d.event_id, d.endpoint_id, d.attempt_count, d.max_attempts`,
    [p.limit, p.workerId, p.leaseMs / 1000],
  );
  return r.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    eventId: row.event_id,
    endpointId: row.endpoint_id,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
  }));
}

export interface DeliveryContext {
  eventId: string;
  eventType: string;
  payload: unknown;
  idempotencyKey: string | null;
  eventCreatedAt: Date;
  url: string;
  secret: string;
  endpointActive: boolean;
}

export async function loadDeliveryContext(db: Db, deliveryId: string): Promise<DeliveryContext | null> {
  const r = await db.query(
    `SELECT e.id AS event_id, e.event_type, e.payload, e.idempotency_key, e.created_at AS event_created_at,
            w.url, w.secret, w.active
       FROM deliveries d
       JOIN events e ON e.id = d.event_id
       JOIN webhook_endpoints w ON w.id = d.endpoint_id
      WHERE d.id = $1`,
    [deliveryId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    eventCreatedAt: row.event_created_at,
    url: row.url,
    secret: row.secret,
    endpointActive: row.active,
  };
}

export type Decision =
  | { type: 'success' }
  | { type: 'retry'; delayMs: number }
  | { type: 'dead_letter' };

export interface AttemptRecord {
  outcome: AttemptOutcome;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  startedAt: Date;
  workerId: string;
}

const TARGET_STATUS = { success: 'SUCCESS', retry: 'RETRY_WAITING', dead_letter: 'DEAD_LETTERED' } as const;

/**
 * Record the attempt and move the delivery to its next state in ONE transaction.
 * The UPDATE is fenced: it only applies if this worker still owns the lease for this attempt number.
 * A worker that stalled past its lease and was replaced therefore cannot overwrite the newer owner's result.
 * Returns false if the lease was lost (nothing is written).
 */
export async function finishAttempt(pool: Pool, job: ClaimedJob, workerId: string, attempt: AttemptRecord, decision: Decision): Promise<boolean> {
  const target = TARGET_STATUS[decision.type];
  assertTransition('PROCESSING', target);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const delayMs = decision.type === 'retry' ? decision.delayMs : 0;
    const upd = await client.query(
      `UPDATE deliveries
          SET status = $4,
              locked_by = NULL, locked_at = NULL, lease_until = NULL,
              last_status_code = $5, last_error = $6,
              next_attempt_at = CASE WHEN $4 = 'RETRY_WAITING' THEN now() + make_interval(secs => $7::double precision) ELSE next_attempt_at END,
              completed_at = CASE WHEN $4 IN ('SUCCESS','DEAD_LETTERED') THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt_count = $3
        RETURNING id`,
      [job.id, workerId, job.attemptCount, target, attempt.statusCode, attempt.error, delayMs / 1000],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO delivery_attempts
         (delivery_id, tenant_id, attempt_number, outcome, status_code, error, duration_ms, worker_id, started_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [job.id, job.tenantId, job.attemptCount, attempt.outcome, attempt.statusCode, attempt.error, attempt.durationMs, workerId, attempt.startedAt],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Graceful shutdown: hand an unfinished job back without counting the interrupted attempt. */
export async function releaseJob(db: Db, job: ClaimedJob, workerId: string): Promise<boolean> {
  assertTransition('PROCESSING', 'RETRY_WAITING');
  const r = await db.query(
    `UPDATE deliveries
        SET status = 'RETRY_WAITING', attempt_count = attempt_count - 1, next_attempt_at = now(),
            locked_by = NULL, locked_at = NULL, lease_until = NULL, updated_at = now()
      WHERE id = $1 AND status = 'PROCESSING' AND locked_by = $2 AND attempt_count = $3`,
    [job.id, workerId, job.attemptCount],
  );
  return (r.rowCount ?? 0) > 0;
}
