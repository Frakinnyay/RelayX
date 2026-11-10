export type DeliveryStatus = 'PENDING' | 'PROCESSING' | 'RETRY_WAITING' | 'SUCCESS' | 'DEAD_LETTERED';

export interface Stats {
  events: number;
  deliveries: Record<DeliveryStatus, number>;
}
export interface Endpoint {
  id: string;
  url: string;
  description: string | null;
  active: boolean;
  createdAt: string;
  secret?: string;
}
export interface EventListItem {
  id: string;
  eventType: string;
  endpointId: string;
  createdAt: string;
  deliveryId: string | null;
  status: DeliveryStatus | null;
  attemptCount: number | null;
  maxAttempts: number | null;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
}
export interface Attempt {
  id: string;
  attemptNumber: number;
  outcome: string;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
  workerId: string;
  startedAt: string;
  finishedAt: string;
}
export interface Delivery {
  id: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastStatusCode: number | null;
  lastError: string | null;
  replayOf: string | null;
  createdAt: string;
  attempts: Attempt[];
}
export interface EventDetail {
  id: string;
  eventType: string;
  endpointId: string;
  payload: unknown;
  idempotencyKey: string | null;
  createdAt: string;
  deliveries: Delivery[];
}
export interface DeliveryListItem {
  id: string;
  eventId: string;
  eventType: string;
  status: DeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  lastStatusCode: number | null;
  lastError: string | null;
  replayOf: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface ReceiverState {
  status: 'healthy' | 'failing';
  remainingSeconds: number;
  uniqueEventsProcessed: number;
  stats: { received: number; succeeded: number; failed: number; duplicates: number; badSignatures: number };
  recent: { at: string; eventId: string; eventType: string; attempt: number; signatureValid: boolean; responded: string; duplicate: boolean }[];
}
