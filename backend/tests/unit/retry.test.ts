import { computeBackoffMs, parseRetryAfterMs, type RetryPolicy } from '../../src/domain/retry';

const policy: RetryPolicy = { baseDelayMs: 5000, factor: 3, maxDelayMs: 120000, jitter: 0.25 };

describe('computeBackoffMs', () => {
  it('grows exponentially and is capped (midpoint of the jitter range)', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6].map((a) => computeBackoffMs(a, policy, mid))).toEqual([5000, 15000, 45000, 120000, 120000, 120000]);
  });

  it('keeps the delay inside +/- jitter bounds', () => {
    expect(computeBackoffMs(1, policy, () => 0)).toBe(3750);
    expect(computeBackoffMs(1, policy, () => 1)).toBe(6250);
  });

  it('produces different delays for different random draws (jitter spreads retries)', () => {
    const values = new Set(Array.from({ length: 200 }, () => computeBackoffMs(3, policy)));
    expect(values.size).toBeGreaterThan(50);
  });

  it('with zero jitter is deterministic', () => {
    const p = { ...policy, jitter: 0 };
    expect(computeBackoffMs(2, p, () => 0.99)).toBe(15000);
  });

  it('treats attempt numbers below 1 as 1', () => {
    expect(computeBackoffMs(0, policy, () => 0.5)).toBe(5000);
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta seconds', () => expect(parseRetryAfterMs('7')).toBe(7000));
  it('parses HTTP dates relative to now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30000);
  });
  it('returns null for missing or garbage values', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
  });
});
