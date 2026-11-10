import type { Pool } from 'pg';
import { isTerminal } from '../domain/state';
import { conflict, notFound } from '../errors';
import { findEndpoint } from '../repositories/endpoints';
import { findEvent } from '../repositories/events';
import { findDelivery, insertDelivery, listAttempts, listDeliveriesForEvent, type DeliveryRow } from '../repositories/deliveries';

/** Creates a NEW delivery for the same event. The original delivery and its attempt history are never touched. */
export async function replayDelivery(pool: Pool, tenantId: string, deliveryId: string, maxAttempts: number): Promise<DeliveryRow> {
  const original = await findDelivery(pool, tenantId, deliveryId);
  if (!original) throw notFound('Delivery');
  if (!isTerminal(original.status)) {
    throw conflict('INVALID_STATE', `Only finished deliveries can be replayed (current status: ${original.status})`);
  }
  const endpoint = await findEndpoint(pool, tenantId, original.endpointId);
  if (!endpoint || !endpoint.active) throw conflict('ENDPOINT_INACTIVE', 'The endpoint is deactivated; cannot replay');
  return insertDelivery(pool, { tenantId, eventId: original.eventId, endpointId: original.endpointId, maxAttempts, replayOf: original.id });
}

export async function getEventDetail(pool: Pool, tenantId: string, eventId: string): Promise<Record<string, unknown>> {
  const event = await findEvent(pool, tenantId, eventId);
  if (!event) throw notFound('Event');
  const deliveries = await listDeliveriesForEvent(pool, tenantId, eventId);
  const attempts = await listAttempts(pool, tenantId, deliveries.map((d) => d.id));
  return {
    ...event,
    requestHash: undefined,
    deliveries: deliveries.map((d) => ({ ...d, attempts: attempts.filter((a) => a.deliveryId === d.id) })),
  };
}

export async function getDeliveryDetail(pool: Pool, tenantId: string, deliveryId: string): Promise<Record<string, unknown>> {
  const delivery = await findDelivery(pool, tenantId, deliveryId);
  if (!delivery) throw notFound('Delivery');
  const attempts = await listAttempts(pool, tenantId, [delivery.id]);
  return { ...delivery, attempts };
}
