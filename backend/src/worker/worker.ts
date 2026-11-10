import type { Pool } from 'pg';
import type { Config } from '../config';
import { classifyStatus, type AttemptOutcome } from '../domain/classify';
import { computeBackoffMs, parseRetryAfterMs } from '../domain/retry';
import { signPayload } from '../domain/signature';
import { errorMessage, type Logger } from '../logger';
import type { WorkerMetrics } from '../metrics';
import { claimJobs, finishAttempt, loadDeliveryContext, releaseJob, type AttemptRecord, type ClaimedJob, type Decision } from '../repositories/queue';
import { purgeOldBuckets } from '../repositories/rateLimit';
import { sleep } from '../util/sleep';
import { sendWebhook, type Sender } from './httpClient';

export interface WorkerDeps {
  pool: Pool;
  config: Config;
  logger: Logger;
  metrics: WorkerMetrics;
  workerId: string;
  send?: Sender;
}

const MAX_RETRY_AFTER_MS = 300_000;

export class Worker {
  private readonly inflight = new Set<Promise<void>>();
  private readonly abort = new AbortController();
  private stopping = false;
  private lastMaintenance = 0;
  private readonly send: Sender;

  constructor(private readonly deps: WorkerDeps) {
    this.send = deps.send ?? sendWebhook;
  }

  /** Claim as many jobs as there is free capacity for and start processing them. Returns number claimed. */
  async tick(): Promise<number> {
    const { config, pool, metrics, workerId } = this.deps;
    const free = config.WORKER_CONCURRENCY - this.inflight.size;
    if (this.stopping || free <= 0) return 0;
    const jobs = await claimJobs(pool, { workerId, limit: free, leaseMs: config.LEASE_DURATION_MS });
    metrics.claimed.inc(jobs.length);
    for (const job of jobs) this.track(this.processJob(job));
    return jobs.length;
  }

  /** Test helper: claim, then wait for everything started to finish. */
  async tickAndWait(): Promise<number> {
    const n = await this.tick();
    await Promise.all([...this.inflight]);
    return n;
  }

  private track(p: Promise<void>): void {
    this.inflight.add(p);
    this.deps.metrics.inflight.set(this.inflight.size);
    void p.finally(() => {
      this.inflight.delete(p);
      this.deps.metrics.inflight.set(this.inflight.size);
    });
  }

  /** Main loop. Survives database outages by logging, backing off, and trying again. */
  async run(): Promise<void> {
    const { config, logger, metrics } = this.deps;
    let errorBackoff = 500;
    logger.info('worker_started', { concurrency: config.WORKER_CONCURRENCY });
    while (!this.stopping) {
      try {
        const claimed = await this.tick();
        errorBackoff = 500;
        await this.maintenance();
        if (claimed === 0) await sleep(config.WORKER_POLL_INTERVAL_MS);
        else if (this.inflight.size >= config.WORKER_CONCURRENCY) await sleep(25);
      } catch (err) {
        metrics.loopErrors.inc();
        logger.error('worker_loop_error', { error: errorMessage(err), retryInMs: errorBackoff });
        await sleep(errorBackoff);
        errorBackoff = Math.min(errorBackoff * 2, 10_000);
      }
    }
  }

  private async maintenance(): Promise<void> {
    if (Date.now() - this.lastMaintenance < 60_000) return;
    this.lastMaintenance = Date.now();
    await purgeOldBuckets(this.deps.pool);
  }

  /**
   * Graceful shutdown sequence:
   * 1. stop claiming new jobs
   * 2. wait up to graceMs for in-flight deliveries to finish and record their results
   * 3. abort whatever is still running; aborted jobs are released back to RETRY_WAITING (attempt not counted)
   * (the caller then closes the pool)
   */
  async stop(graceMs: number = this.deps.config.SHUTDOWN_GRACE_MS): Promise<void> {
    this.stopping = true;
    this.deps.logger.info('worker_stopping', { inflight: this.inflight.size, graceMs });
    const drained = Promise.all([...this.inflight]).then(() => true);
    const finished = await Promise.race([drained, sleep(graceMs).then(() => false)]);
    if (!finished) {
      this.deps.logger.warn('worker_grace_expired_aborting', { inflight: this.inflight.size });
      this.abort.abort();
      await Promise.all([...this.inflight]);
    }
    this.deps.logger.info('worker_stopped');
  }

  private async processJob(job: ClaimedJob): Promise<void> {
    const { pool, config, metrics, workerId } = this.deps;
    const log = this.deps.logger.child({ workerId, deliveryId: job.id, eventId: job.eventId, tenantId: job.tenantId, attempt: job.attemptCount });
    const startedAt = new Date();
    const t0 = Date.now();
    try {
      const ctx = await loadDeliveryContext(pool, job.id);
      let attempt: AttemptRecord;
      let decision: Decision;

      if (!ctx || !ctx.endpointActive || job.attemptCount > job.maxAttempts) {
        const reason = !ctx ? 'DELIVERY_CONTEXT_MISSING' : !ctx.endpointActive ? 'ENDPOINT_DISABLED' : 'MAX_ATTEMPTS_EXCEEDED_AFTER_LEASE_EXPIRY';
        attempt = { outcome: 'PERMANENT_FAILURE', statusCode: null, error: reason, durationMs: 0, startedAt, workerId };
        decision = { type: 'dead_letter' };
      } else {
        const body = JSON.stringify({
          id: ctx.eventId,
          type: ctx.eventType,
          idempotencyKey: ctx.idempotencyKey,
          createdAt: ctx.eventCreatedAt,
          data: ctx.payload,
        });
        const ts = Math.floor(Date.now() / 1000);
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'RelayX/1.0',
          'X-RelayX-Event-Id': ctx.eventId,
          'X-RelayX-Event-Type': ctx.eventType,
          'X-RelayX-Delivery-Id': job.id,
          'X-RelayX-Attempt': String(job.attemptCount),
          'X-RelayX-Timestamp': String(ts),
          'X-RelayX-Signature': signPayload(ctx.secret, ts, body),
        };
        if (ctx.idempotencyKey) headers['X-RelayX-Idempotency-Key'] = ctx.idempotencyKey;

        const res = await this.send({
          url: ctx.url,
          body,
          headers,
          timeoutMs: config.DELIVERY_TIMEOUT_MS,
          allowPrivate: config.ALLOW_PRIVATE_WEBHOOK_TARGETS,
          signal: this.abort.signal,
        });

        if (res.aborted) {
          // Shutdown interrupted us mid-request: give the job back, do not burn an attempt.
          const released = await releaseJob(pool, job, workerId);
          log.info('delivery_released_on_shutdown', { released });
          return;
        }

        const durationMs = Date.now() - t0;
        let outcome: AttemptOutcome;
        if (res.statusCode !== null) outcome = classifyStatus(res.statusCode);
        else outcome = res.blocked ? 'PERMANENT_FAILURE' : 'RETRYABLE_FAILURE'; // network error / timeout -> retry
        const error = res.error ?? (outcome === 'SUCCESS' ? null : `HTTP ${res.statusCode}`);
        attempt = { outcome, statusCode: res.statusCode, error, durationMs, startedAt, workerId };
        metrics.attemptDuration.observe(durationMs / 1000);

        if (outcome === 'SUCCESS') decision = { type: 'success' };
        else if (outcome === 'PERMANENT_FAILURE' || job.attemptCount >= job.maxAttempts) decision = { type: 'dead_letter' };
        else {
          const backoff = computeBackoffMs(job.attemptCount, {
            baseDelayMs: config.RETRY_BASE_DELAY_MS,
            factor: config.RETRY_FACTOR,
            maxDelayMs: config.RETRY_MAX_DELAY_MS,
            jitter: config.RETRY_JITTER,
          });
          const retryAfter = Math.min(parseRetryAfterMs(res.retryAfterHeader) ?? 0, MAX_RETRY_AFTER_MS);
          decision = { type: 'retry', delayMs: Math.max(backoff, retryAfter) };
        }
      }

      const recorded = await finishAttempt(pool, job, workerId, attempt, decision);
      if (!recorded) {
        metrics.leaseLost.inc();
        log.warn('lease_lost_result_discarded');
        return;
      }
      metrics.attempts.inc({ outcome: attempt.outcome });
      if (decision.type === 'success') metrics.succeeded.inc();
      if (decision.type === 'retry') metrics.retriesScheduled.inc();
      if (decision.type === 'dead_letter') metrics.deadLettered.inc();
      log.info('delivery_attempt_finished', {
        outcome: attempt.outcome,
        decision: decision.type,
        status: attempt.statusCode,
        durationMs: attempt.durationMs,
        ...(decision.type === 'retry' ? { retryInMs: decision.delayMs } : {}),
      });
    } catch (err) {
      // e.g. database went away while recording. The job stays PROCESSING and is reclaimed after its lease expires.
      log.error('delivery_processing_error', { error: errorMessage(err) });
    }
  }
}
