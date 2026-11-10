import type { Db } from '../db/pool';
import type { DeliveryStatus } from '../domain/state';
import { camelize } from '../util/camel';

export interface DeliveryRow {
  id: string;
  tenantId: string;
  eventId: string;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastStatusCode: number | null;
  lastError: string | null;
  replayOf: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

// Lock columns (locked_by, lease_until...) are internal and not exposed through the API.
const PUBLIC = `id, tenant_id, event_id, endpoint_id, status, attempt_count, max_attempts, next_attempt_at,
  last_status_code, last_error, replay_of, created_at, updated_at, completed_at`;

export async function insertDelivery(
  db: Db,
  p: { tenantId: string; eventId: string; endpointId: string; maxAttempts: number; replayOf?: string },
): Promise<DeliveryRow> {
  const r = await db.query(
    `INSERT INTO deliveries (tenant_id, event_id, endpoint_id, max_attempts, replay_of)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC}`,
    [p.tenantId, p.eventId, p.endpointId, p.maxAttempts, p.replayOf ?? null],
  );
  return camelize(r.rows[0]);
}

export async function findDelivery(db: Db, tenantId: string, id: string): Promise<DeliveryRow | null> {
  const r = await db.query(`SELECT ${PUBLIC} FROM deliveries WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ? camelize<DeliveryRow>(r.rows[0]) : null;
}

export async function firstDeliveryForEvent(db: Db, tenantId: string, eventId: string): Promise<DeliveryRow | null> {
  const r = await db.query(
    `SELECT ${PUBLIC} FROM deliveries WHERE event_id = $1 AND tenant_id = $2 AND replay_of IS NULL ORDER BY created_at ASC LIMIT 1`,
    [eventId, tenantId],
  );
  return r.rows[0] ? camelize<DeliveryRow>(r.rows[0]) : null;
}

export async function listDeliveriesForEvent(db: Db, tenantId: string, eventId: string): Promise<DeliveryRow[]> {
  const r = await db.query(`SELECT ${PUBLIC} FROM deliveries WHERE event_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`, [
    eventId,
    tenantId,
  ]);
  return r.rows.map((row) => camelize<DeliveryRow>(row));
}

export async function listDeliveries(
  db: Db,
  tenantId: string,
  p: { status?: DeliveryStatus; limit: number; offset: number },
): Promise<Record<string, unknown>[]> {
  const r = await db.query(
    `SELECT d.id, d.event_id, d.endpoint_id, d.status, d.attempt_count, d.max_attempts, d.next_attempt_at,
            d.last_status_code, d.last_error, d.replay_of, d.created_at, d.completed_at, e.event_type
       FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.tenant_id = $1 AND ($2::text IS NULL OR d.status = $2)
      ORDER BY d.created_at DESC
      LIMIT $3 OFFSET $4`,
    [tenantId, p.status ?? null, p.limit, p.offset],
  );
  return r.rows.map((row) => camelize<Record<string, unknown>>(row));
}

export interface AttemptRow {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  outcome: string;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  workerId: string;
  startedAt: Date;
  finishedAt: Date;
}

export async function listAttempts(db: Db, tenantId: string, deliveryIds: string[]): Promise<AttemptRow[]> {
  if (deliveryIds.length === 0) return [];
  const r = await db.query(
    `SELECT id, delivery_id, attempt_number, outcome, status_code, error, duration_ms, worker_id, started_at, finished_at
       FROM delivery_attempts WHERE tenant_id = $1 AND delivery_id = ANY($2::uuid[])
      ORDER BY delivery_id, attempt_number`,
    [tenantId, deliveryIds],
  );
  return r.rows.map((row) => camelize<AttemptRow>(row));
}

export async function statusCounts(db: Db, tenantId: string): Promise<Record<string, number>> {
  const r = await db.query('SELECT status, count(*)::int AS n FROM deliveries WHERE tenant_id = $1 GROUP BY status', [tenantId]);
  const out: Record<string, number> = { PENDING: 0, PROCESSING: 0, RETRY_WAITING: 0, SUCCESS: 0, DEAD_LETTERED: 0 };
  for (const row of r.rows) out[row.status as string] = row.n as number;
  return out;
}

export async function eventCount(db: Db, tenantId: string): Promise<number> {
  const r = await db.query('SELECT count(*)::int AS n FROM events WHERE tenant_id = $1', [tenantId]);
  return r.rows[0].n as number;
}
