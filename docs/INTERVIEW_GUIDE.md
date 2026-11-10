# Interview guide

Use these as *thinking aids*; answer in your own words and point at the code/tests. Rule: never claim a number you haven't measured.

## Architecture
**Why this architecture?** Customers' servers are unreliable, so ingestion must be decoupled from delivery: accept → durably store → deliver asynchronously with retries. API and worker are separate processes that share only PostgreSQL.
**Why PostgreSQL as a queue?** Transactional enqueue (event and job commit together), one system to operate, SQL visibility, enough throughput for this scale. I know the ceiling (write amplification, polling latency) and what I'd do at 100× (see ENGINEERING_DECISIONS).
**Why not Redis/BullMQ?** Two stores = dual-write consistency problem (event in DB, job lost in Redis, or vice-versa), plus another service to run. BullMQ is a fine choice when you already operate Redis and need higher throughput — I chose Postgres deliberately to demonstrate how queue semantics work underneath.
**Why separate API and worker?** Isolation of failure and scaling; the request path never waits on a customer.

## Database
**How does SKIP LOCKED work?** `SELECT … FOR UPDATE` row-locks the chosen rows; `SKIP LOCKED` tells other transactions to ignore locked rows instead of blocking. Claim = select-and-update in one statement, so a job is either claimable or owned. *Show:* `queue.test.ts` — 10 connections claim 200 jobs: 200 distinct ids; and a test where one transaction holds a row lock and another claim returns immediately with nothing.
**How do transactions protect claiming?** The lock and the status flip are atomic; if a worker dies mid-statement the transaction rolls back and the row is untouched.
**Why these indexes?** Partial indexes on exactly the predicates of the claim and lease queries (small, hot); unique partial index for idempotency (correctness + lookup); `(tenant_id, status, created_at)` for dashboards. Prove with `EXPLAIN`.
**Why PostgreSQL generally?** ACID, partial/unique indexes, JSONB for payloads, row-level locking primitives.

## Reliability
**At-least-once?** Delivered ≥ 1 times. **Why duplicates?** timeout after the receiver processed it; worker crash after sending but before recording; lease expiry with a slow worker; manual replay. **Mitigation:** stable event id + idempotency key headers; receiver dedupes.
**How does idempotency work?** Unique `(tenant, key)`; `INSERT … ON CONFLICT DO NOTHING`; if nothing inserted, return the original. A SELECT-then-INSERT check races: both see nothing and both insert. Test: 25 concurrent requests → 1 event.
**Worker crash?** Job stays PROCESSING until `lease_until` passes; any worker reclaims it. Fencing stops a zombie worker from overwriting results.
**Why exponential backoff? Why jitter?** Give the receiver time to recover; avoid synchronized retry storms.
**Dead-letter?** After max attempts or a permanent error the delivery is marked DEAD_LETTERED, all attempts preserved; replay inserts a new delivery.
**What if the DB goes down?** API returns errors (ingestion is one transaction, so nothing partial); worker loop backs off and resumes; in-flight jobs recover via leases.

## Security
**Why hash API keys?** A DB leak shouldn't hand out working credentials. SHA-256 is fine because the keys are 192-bit random; bcrypt is for human passwords.
**Why HMAC?** Receiver can verify authenticity and integrity. **Replay attacks?** Timestamp is part of the signed message; receiver rejects stale timestamps and can dedupe event ids.
**Tenant isolation?** Every query is scoped by `tenant_id` taken from the authenticated key, never from the request body; tests cover cross-tenant reads, replays and endpoint use.
**SSRF?** The product makes outbound requests to user-chosen URLs. Validate scheme/host at creation, re-validate and resolve DNS at send time rejecting private ranges, connect to the validated IP, never follow redirects. Limits: no egress allow-list — a network-level control I'd add in production.

## Performance (fill with YOUR numbers)
**Bottleneck?** Hypothesis: Postgres write volume on deliveries/attempts, then worker concurrency × receiver latency. *Evidence from my runs:* with 1 worker, delivery fell ~18 s behind ingestion at ~183 events/s; 3 workers nearly kept pace (69 → ≥133 events/s). Ingestion itself stayed flat (p95 ≈ 46 ms) up to 150/s and saturated near 200/s on a laptop where everything shares the CPU. I did not profile `pg_stat_statements`.
**What did k6 measure?** Ingestion req/s, p50/p95 latency, error rate, worker end-to-end throughput — full tables in PERFORMANCE_TESTING.md. Highlights: 150 req/s at p95 46 ms with 0 errors; worker 69 → ≥133 events/s with 1 → 3 workers.
**Scale workers?** More worker processes/containers (safe thanks to SKIP LOCKED) and/or higher `WORKER_CONCURRENCY`; limited by DB connections and receiver capacity.
**100× volume?** See ENGINEERING_DECISIONS (partitioning, vacuum tuning, per-endpoint limits, broker in front).

## AWS (optional part)
**Why EC2/RDS/ECR?** EC2 = simplest to understand (a Linux box running Compose); RDS = managed Postgres backups/patching (cost-checked); ECR = private image registry. **CI/CD?** GitHub Actions builds, pushes, then triggers deploy over SSH; AWS access via OIDC role, no stored keys. **ECS later?** Task definitions for api/worker, service autoscaling on queue depth, RDS in private subnets, ALB — only when needed. If you never deployed, say so honestly and describe the plan.

## Realistic questions
1. *"What happens if two workers claim the same job?"* — can't, and here's the test.
2. *"Isn't polling wasteful?"* — yes; interval is configurable; `LISTEN/NOTIFY` removes most idle polling.
3. *"Why not exactly-once?"* — impossible across a network failure; we get effectively-once with idempotent receivers.
4. *"A tenant's endpoint is down for a week?"* — events dead-letter after max attempts; replay later; at scale add circuit breakers so it doesn't consume worker slots.
5. *"How do you keep one noisy tenant from starving others?"* — currently rate limit on ingestion only; add fair claiming per tenant/endpoint concurrency caps.
6. *"How would you test the lease logic?"* — set `lease_until` in the past, claim from another worker (see tests).
7. *"What's missing?"* — ordering guarantees, secret encryption, circuit breakers, auth for metrics by default, load-test results until I run them.

## Stories from the load tests (use these — they are real)
1. **Pool deadlock.** 500 simultaneous requests with one idempotency key: the database kept exactly one event (the unique index held), but 467 requests failed. Cause: the duplicate path held a connection and asked the pool for a second; under load all connections waited on each other. Fix: reuse the transaction's connection. Added a regression test that fires 100 duplicates through a 3-connection pool; re-ran k6: 499 correct replies, 0 errors. Lesson: correctness of the data is not the same as correctness of the API under load.
2. **Wrong endpoint in my own benchmark.** My first k6 run sent events to a deliberately broken demo endpoint, so everything dead-lettered. I noticed from the dashboard (SUCCESS 7, DEAD_LETTERED 11,813), discarded the numbers and fixed the script. Lesson: sanity-check the *outcome*, not just the latency.
3. **Crash vs graceful stop.** SIGKILL: 3 jobs stuck, recovered after the 60 s lease, 3 duplicates at the receiver. SIGTERM: 0 stuck, 0 duplicates, shutdown in 13 ms. Explains why at-least-once exists and why graceful shutdown matters.
4. **Head-of-line blocking.** During a dead receiver 49 of 201 events hadn't had a first attempt after 10 s because timeouts held all 5 worker slots. Fix I'd make: per-endpoint concurrency limits / circuit breaker.
