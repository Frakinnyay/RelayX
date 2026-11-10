# Reliability

## Delivery guarantee: at-least-once (never claimed exactly-once)
RelayX makes sure an accepted event is delivered **one or more** times. Duplicates are possible: the receiver can process an event and
crash before answering; the worker sees a timeout and (correctly) retries. Exactly-once over an unreliable network is impossible;
what you can build is *at-least-once delivery + idempotent receiver*. Every request carries `X-RelayX-Event-Id` (stable across retries
and replays) and `X-RelayX-Idempotency-Key` (if the producer supplied one); receivers should store processed ids and ignore repeats.
The receiver simulator does exactly this and counts duplicates in the dashboard.

## Request format
`POST <endpoint url>`, JSON body `{id, type, idempotencyKey, createdAt, data}`.
Headers: `X-RelayX-Event-Id`, `X-RelayX-Event-Type`, `X-RelayX-Delivery-Id`, `X-RelayX-Attempt`, `X-RelayX-Timestamp` (unix seconds), `X-RelayX-Signature`.

## HMAC signature
- Algorithm: HMAC-SHA256, key = endpoint secret.
- Signed message (canonical): `<timestamp> + "." + <raw request body bytes as sent>`.
- Header: `X-RelayX-Signature: v1=<lowercase hex>`.
- Verify: recompute over the **raw** body (not re-serialised JSON), compare in constant time, and reject if `|now − timestamp| > 300 s`.
- Replay protection: a captured request can be replayed only within the tolerance window; for stronger protection also store seen event ids. Each retry is re-signed with a fresh timestamp, so a retry never fails the freshness check.
- Node example (receiver side) is the function `verifySignature` in `backend/src/domain/signature.ts`.
- Secrets are never logged and never returned by the API after creation.

## Stuck-job recovery (lease)
Claiming sets `locked_by`, `locked_at`, `lease_until = now() + LEASE_DURATION_MS` (default 60 s ≫ request timeout 5 s).
If a worker dies after claiming, the row stays `PROCESSING`, but once `lease_until < now()` the claim query's second branch treats it as claimable and
another worker takes it (the dead attempt counts toward `attempt_count`; if that exceeds `max_attempts` it is dead-lettered without sending).
**Fencing:** results are written with `WHERE locked_by = me AND attempt_count = n AND status='PROCESSING'`; a worker that was merely slow (not dead) and lost its lease
cannot overwrite the new owner's result (test: `queue.test.ts` "fencing"). Consequence: a slow-but-alive worker can cause a duplicate send — acceptable under at-least-once.

## Graceful shutdown (worker)
`SIGTERM`/`SIGINT` → (1) stop claiming; (2) wait up to `SHUTDOWN_GRACE_MS` (15 s) for in-flight deliveries to finish and record results; (3) abort the rest — each aborted job is **released**
to `RETRY_WAITING` with its attempt not counted; (4) close the DB pool; (5) exit 0. Docker's `stop_grace_period` (20 s) is longer than the grace period so the container is not killed mid-drain. If the process is `SIGKILL`ed anyway, lease recovery covers it.

## Idempotency (producer → RelayX)
`UNIQUE (tenant_id, idempotency_key)` is enforced by PostgreSQL. Why application-only checks fail: two concurrent requests both run `SELECT` (nothing found), both `INSERT` → duplicate.
The unique index serialises them: the second `INSERT ... ON CONFLICT DO NOTHING` waits for the first transaction, then returns no row, and the API returns the original event (HTTP 200, `idempotentReplay: true`). Same key + different body → 409 `IDEMPOTENCY_KEY_REUSED`. Keys are scoped per tenant. Test: 25 concurrent identical requests → exactly 1 event, 1 delivery.

## Retries and jitter
Retry on: network error, connection refused, timeout, 5xx, 408, 429 (honouring `Retry-After`, capped at 5 min). Not retried: 400, 401, 403, 404, other 4xx, 3xx (redirects are never followed).
`delay = min(base × factor^(n−1), max) × (1 ± jitter)`. Without jitter, 10,000 events that failed during one outage all retry at exactly the same instants and hammer the recovering receiver ("retry storm", "thundering herd"); jitter spreads them over a window.

## Failure scenarios
| # | Scenario | What RelayX does |
|---|---|---|
| 1 | Receiver 200 | `SUCCESS`, attempt recorded |
| 2 | 400 | permanent: `DEAD_LETTERED` after 1 attempt (replay possible) |
| 3 | 401 | permanent: dead-lettered (credentials/signature problem retrying cannot fix) |
| 4 | 404 | permanent: dead-lettered |
| 5 | 429 | retryable, delay ≥ `Retry-After` |
| 6 | 500 / 502 / 503 | retryable with backoff + jitter |
| 7 | Timeout (`DELIVERY_TIMEOUT_MS`) | request aborted, retryable, `error = TIMEOUT` |
| 8 | Receiver down (ECONNREFUSED/DNS) | retryable; dead-lettered after `MAX_ATTEMPTS` if it never recovers |
| 9 | Worker crashes | lease expires → another worker reclaims; possible duplicate delivery |
| 10 | Database unavailable | API: `/health` → 503, requests fail with 500 (nothing half-written: ingestion is one transaction). Worker: loop logs `worker_loop_error`, backs off 0.5 s → 10 s, resumes automatically. In-flight result write fails → job stays `PROCESSING` → lease recovery. |
| 11 | Duplicate event submission | idempotency key → original returned, nothing created |
| 12 | Duplicate delivery | possible by design; receiver dedupes on event id |
| 13 | Receiver recovers | next retry succeeds; full failure history remains in `delivery_attempts` |
| 14 | Destination resolves to a private IP | blocked (SSRF), permanent failure, request never sent |
| 15 | Endpoint deactivated while queued | dead-lettered with `ENDPOINT_DISABLED` |

## What is intentionally not covered
Ordering (events may be delivered out of order, especially after retries), per-endpoint concurrency limits / circuit breakers, multi-region failover, encryption of secrets at rest.
