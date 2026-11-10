export const DELIVERY_STATUSES = ['PENDING', 'PROCESSING', 'RETRY_WAITING', 'SUCCESS', 'DEAD_LETTERED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// The only legal transitions. Anything else is a bug and throws.
//  PENDING/RETRY_WAITING -> PROCESSING   a worker claimed the job
//  PROCESSING -> PROCESSING              lease expired, another worker reclaimed it
//  PROCESSING -> SUCCESS                 2xx received
//  PROCESSING -> RETRY_WAITING           retryable failure (or graceful release on shutdown)
//  PROCESSING -> DEAD_LETTERED           permanent failure or attempts exhausted
// SUCCESS and DEAD_LETTERED are terminal. A replay creates a NEW delivery row.
const TRANSITIONS: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  PENDING: ['PROCESSING'],
  RETRY_WAITING: ['PROCESSING'],
  PROCESSING: ['PROCESSING', 'SUCCESS', 'RETRY_WAITING', 'DEAD_LETTERED'],
  SUCCESS: [],
  DEAD_LETTERED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: DeliveryStatus, to: DeliveryStatus) {
    super(`Invalid delivery transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: DeliveryStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
