export interface RetryPolicy {
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
  /** 0..1. 0.25 means the delay is randomised within +/-25%. */
  jitter: number;
}

/**
 * Delay before the NEXT attempt, given the attempt that just failed (1-based).
 * delay = min(base * factor^(attempt-1), max), then randomised by +/- jitter.
 * Jitter spreads retries out so thousands of failures from one outage do not
 * all hit the recovering receiver at the same instant (retry storm).
 */
export function computeBackoffMs(attempt: number, policy: RetryPolicy, rng: () => number = Math.random): number {
  const n = Math.max(1, attempt);
  const exponential = Math.min(policy.baseDelayMs * Math.pow(policy.factor, n - 1), policy.maxDelayMs);
  const spread = exponential * policy.jitter;
  return Math.max(0, Math.round(exponential - spread + rng() * 2 * spread));
}

/** Parses a Retry-After header (delta-seconds or HTTP date). Returns ms or null. */
export function parseRetryAfterMs(header: string | undefined, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}
