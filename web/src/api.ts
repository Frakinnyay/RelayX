import type { DeliveryListItem, Endpoint, EventDetail, EventListItem, ReceiverState, Stats } from './types';

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';
export const RECEIVER_URL: string = import.meta.env.VITE_RECEIVER_URL ?? 'http://localhost:4000';

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

export class RelayXClient {
  constructor(private readonly apiKey: string) {}

  private req<T>(method: string, path: string, body?: unknown): Promise<T> {
    return call<T>(`${API_URL}/api/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  stats = (): Promise<Stats> => this.req('GET', '/stats');
  endpoints = async (): Promise<Endpoint[]> => (await this.req<{ data: Endpoint[] }>('GET', '/endpoints')).data;
  createEndpoint = (body: { url: string; description?: string; secret?: string }): Promise<Endpoint> => this.req('POST', '/endpoints', body);
  deactivateEndpoint = (id: string): Promise<Endpoint> => this.req('DELETE', `/endpoints/${id}`);
  events = async (limit = 30): Promise<EventListItem[]> => (await this.req<{ data: EventListItem[] }>('GET', `/events?limit=${limit}`)).data;
  event = (id: string): Promise<EventDetail> => this.req('GET', `/events/${id}`);
  deliveries = async (status?: string, limit = 50): Promise<DeliveryListItem[]> =>
    (await this.req<{ data: DeliveryListItem[] }>('GET', `/deliveries?limit=${limit}${status ? `&status=${status}` : ''}`)).data;
  replay = (deliveryId: string): Promise<unknown> => this.req('POST', `/deliveries/${deliveryId}/replay`);
  sendEvent = (endpointId: string, eventType: string, payload: Record<string, unknown>): Promise<unknown> =>
    this.req('POST', '/events', { endpointId, eventType, payload, idempotencyKey: crypto.randomUUID() });
}

export const receiver = {
  state: (): Promise<ReceiverState> => call(`${RECEIVER_URL}/control/state`),
  fail: (seconds: number): Promise<unknown> =>
    call(`${RECEIVER_URL}/control/fail`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seconds }) }),
  heal: (): Promise<unknown> => call(`${RECEIVER_URL}/control/heal`, { method: 'POST' }),
  reset: (): Promise<unknown> => call(`${RECEIVER_URL}/control/reset`, { method: 'POST' }),
};
