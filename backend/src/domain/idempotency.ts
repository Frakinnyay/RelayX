import { createHash } from 'node:crypto';

export interface EventRequestFingerprint {
  eventType: string;
  endpointId: string;
  payload: unknown;
  metadata: unknown;
}

/** Hash of the request body. Same idempotency key + different hash = client bug -> 409. */
export function computeRequestHash(input: EventRequestFingerprint): string {
  return createHash('sha256')
    .update(JSON.stringify([input.eventType, input.endpointId, input.payload, input.metadata]))
    .digest('hex');
}
