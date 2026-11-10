import type { Pool } from 'pg';
import type { Config } from '../config';
import { computeRequestHash } from '../domain/idempotency';
import { badRequest, conflict } from '../errors';
import { firstDeliveryForEvent, insertDelivery, type DeliveryRow } from '../repositories/deliveries';
import { findEventByIdempotencyKey, insertEventIfNew, type EventRow } from '../repositories/events';

export interface IngestInput {
  eventType: string;
  endpointId: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface IngestResult {
  event: Pick<EventRow, 'id' | 'eventType' | 'endpointId' | 'idempotencyKey' | 'createdAt'>;
  delivery: Pick<DeliveryRow, 'id' | 'status' | 'attemptCount' | 'nextAttemptAt'> | null;
  idempotentReplay: boolean;
}

const summarize = (e: EventRow): IngestResult['event'] => ({
  id: e.id,
  eventType: e.eventType,
  endpointId: e.endpointId,
  idempotencyKey: e.idempotencyKey,
  createdAt: e.createdAt,
});

/**
 * Steps (one transaction): verify endpoint belongs to tenant -> insert event (unique index decides duplicates)
 * -> insert delivery job. Event + job commit together or not at all, so there is never an event without a job.
 *
 * Why application-only "SELECT then INSERT" is unsafe: two requests can both SELECT, both see nothing, and both
 * INSERT. The unique index makes the second INSERT lose no matter how the requests interleave.
 */
export async function ingestEvent(pool: Pool, config: Config, tenantId: string, input: IngestInput): Promise<IngestResult> {
  const requestHash = computeRequestHash(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ep = await client.query('SELECT active FROM webhook_endpoints WHERE id = $1 AND tenant_id = $2', [input.endpointId, tenantId]);
    if (!ep.rows[0]) throw badRequest('ENDPOINT_NOT_FOUND', 'endpointId does not exist for this tenant');
    if (!ep.rows[0].active) throw badRequest('ENDPOINT_INACTIVE', 'endpoint is deactivated');

    const created = await insertEventIfNew(client, {
      tenantId,
      endpointId: input.endpointId,
      eventType: input.eventType,
      payload: input.payload,
      metadata: input.metadata,
      idempotencyKey: input.idempotencyKey ?? null,
      requestHash,
    });

    if (!created) {
      // Duplicate idempotency key: return the ORIGINAL result, create nothing.
      await client.query('ROLLBACK');
      // Reuse THIS connection. Asking the pool for a second one while holding the first deadlocks the pool
      // when many duplicate requests arrive at once (every connection waits for another).
      const existing = await findEventByIdempotencyKey(client, tenantId, input.idempotencyKey as string);
      if (!existing) throw new Error('idempotency conflict but original event not found');
      if (existing.requestHash !== requestHash) {
        throw conflict('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request body');
      }
      const delivery = await firstDeliveryForEvent(client, tenantId, existing.id);
      return { event: summarize(existing), delivery, idempotentReplay: true };
    }

    const delivery = await insertDelivery(client, {
      tenantId,
      eventId: created.id,
      endpointId: input.endpointId,
      maxAttempts: config.MAX_ATTEMPTS,
    });
    await client.query('COMMIT');
    return { event: summarize(created), delivery, idempotentReplay: false };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
