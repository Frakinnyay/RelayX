import type { Db } from '../db/pool';
import { camelize } from '../util/camel';

export interface EventRow {
  id: string;
  tenantId: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
  metadata: unknown;
  idempotencyKey: string | null;
  requestHash: string;
  createdAt: Date;
}

export async function insertEventIfNew(
  db: Db,
  p: {
    tenantId: string;
    endpointId: string;
    eventType: string;
    payload: unknown;
    metadata: unknown;
    idempotencyKey: string | null;
    requestHash: string;
  },
): Promise<EventRow | null> {
  // ON CONFLICT ... DO NOTHING: if another request already inserted this (tenant, key), no row comes back.
  const r = await db.query(
    `INSERT INTO events (tenant_id, endpoint_id, event_type, payload, metadata, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [p.tenantId, p.endpointId, p.eventType, JSON.stringify(p.payload), JSON.stringify(p.metadata), p.idempotencyKey, p.requestHash],
  );
  return r.rows[0] ? camelize<EventRow>(r.rows[0]) : null;
}

export async function findEventByIdempotencyKey(db: Db, tenantId: string, key: string): Promise<EventRow | null> {
  const r = await db.query('SELECT * FROM events WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, key]);
  return r.rows[0] ? camelize<EventRow>(r.rows[0]) : null;
}

export async function findEvent(db: Db, tenantId: string, id: string): Promise<EventRow | null> {
  const r = await db.query('SELECT * FROM events WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return r.rows[0] ? camelize<EventRow>(r.rows[0]) : null;
}

export async function listEvents(db: Db, tenantId: string, limit: number, offset: number): Promise<Record<string, unknown>[]> {
  const r = await db.query(
    `SELECT e.id, e.event_type, e.endpoint_id, e.idempotency_key, e.created_at,
            d.id AS delivery_id, d.status, d.attempt_count, d.max_attempts, d.next_attempt_at, d.last_status_code
       FROM events e
       LEFT JOIN LATERAL (
         SELECT * FROM deliveries WHERE event_id = e.id AND tenant_id = e.tenant_id ORDER BY created_at DESC LIMIT 1
       ) d ON true
      WHERE e.tenant_id = $1
      ORDER BY e.created_at DESC
      LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );
  return r.rows.map((row) => camelize<Record<string, unknown>>(row));
}
