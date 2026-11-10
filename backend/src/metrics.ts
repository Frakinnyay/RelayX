import type { Pool } from 'pg';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { DELIVERY_STATUSES } from './domain/state';

export interface ApiMetrics {
  eventsReceived: Counter<'duplicate'>;
  rateLimited: Counter<string>;
  httpDuration: Histogram<'method' | 'route' | 'status'>;
}

export function createApiMetrics(registry: Registry, pool: Pool): ApiMetrics {
  collectDefaultMetrics({ register: registry });
  new Gauge({
    name: 'relayx_queue_depth',
    help: 'Deliveries by status (computed from PostgreSQL at scrape time)',
    labelNames: ['status'],
    registers: [registry],
    async collect() {
      try {
        const r = await pool.query('SELECT status, count(*)::int AS n FROM deliveries GROUP BY status');
        this.reset();
        for (const s of DELIVERY_STATUSES) this.set({ status: s }, 0);
        for (const row of r.rows) this.set({ status: row.status as string }, row.n as number);
      } catch {
        /* database unavailable: leave gauge empty rather than failing the scrape */
      }
    },
  });
  return {
    eventsReceived: new Counter({ name: 'relayx_events_received_total', help: 'Events accepted by the API', labelNames: ['duplicate'], registers: [registry] }),
    rateLimited: new Counter({ name: 'relayx_rate_limited_total', help: 'Requests rejected by the rate limiter', registers: [registry] }),
    httpDuration: new Histogram({
      name: 'relayx_http_request_duration_seconds',
      help: 'API request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
      registers: [registry],
    }),
  };
}

export interface WorkerMetrics {
  attempts: Counter<'outcome'>;
  attemptDuration: Histogram<string>;
  retriesScheduled: Counter<string>;
  deadLettered: Counter<string>;
  succeeded: Counter<string>;
  claimed: Counter<string>;
  inflight: Gauge<string>;
  loopErrors: Counter<string>;
  leaseLost: Counter<string>;
}

export function createWorkerMetrics(registry: Registry): WorkerMetrics {
  collectDefaultMetrics({ register: registry });
  return {
    attempts: new Counter({ name: 'relayx_delivery_attempts_total', help: 'Delivery attempts by outcome', labelNames: ['outcome'], registers: [registry] }),
    attemptDuration: new Histogram({
      name: 'relayx_delivery_attempt_duration_seconds',
      help: 'Duration of outbound webhook requests',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [registry],
    }),
    retriesScheduled: new Counter({ name: 'relayx_retries_scheduled_total', help: 'Retries scheduled', registers: [registry] }),
    deadLettered: new Counter({ name: 'relayx_dead_lettered_total', help: 'Deliveries moved to dead-letter', registers: [registry] }),
    succeeded: new Counter({ name: 'relayx_deliveries_succeeded_total', help: 'Deliveries completed successfully', registers: [registry] }),
    claimed: new Counter({ name: 'relayx_jobs_claimed_total', help: 'Jobs claimed by this worker', registers: [registry] }),
    inflight: new Gauge({ name: 'relayx_worker_inflight', help: 'Jobs currently being processed by this worker', registers: [registry] }),
    loopErrors: new Counter({ name: 'relayx_worker_loop_errors_total', help: 'Errors in the worker poll loop (e.g. database down)', registers: [registry] }),
    leaseLost: new Counter({ name: 'relayx_lease_lost_total', help: 'Results discarded because the lease was lost', registers: [registry] }),
  };
}
