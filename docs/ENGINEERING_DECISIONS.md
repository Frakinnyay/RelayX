# Engineering decisions

Format: decision → why → alternatives → what it costs.

**PostgreSQL as the queue (not Redis/BullMQ/RabbitMQ/Kafka/SQS).** Event + job are written in *one transaction* with the data they describe, so "event accepted but job lost" cannot happen; there is one system to run, back up and reason about; the queue is queryable with SQL (dead-letter lists, timelines). `SKIP LOCKED` gives safe multi-worker claiming. *Cost:* every claim/complete is a write on the primary; practical ceiling is thousands of jobs/second, not hundreds of thousands; polling adds latency (≤ poll interval). *Alternatives:* Redis/BullMQ is faster but needs dual-write consistency with the DB; Kafka is a log, awkward for per-job retry/delay; SQS is excellent but ties you to AWS and breaks the zero-cost local story.

**At-least-once, not exactly-once.** After sending, the worker cannot know whether a timeout means "not processed" or "processed, reply lost". Retrying risks duplicates; not retrying risks loss. Losing events is worse, so we retry and give receivers a stable event id to deduplicate. *Cost:* receivers must be idempotent.

**API and worker as separate processes.** Customer endpoints are slow/unreliable; the ingestion path must not wait for them. Separate processes scale and fail independently (API 503 doesn't stop deliveries; a stuck worker doesn't block ingestion). Same image, different command, to keep deployment simple.

**Exponential backoff + jitter.** Backoff gives a struggling receiver breathing room; jitter prevents synchronised retry waves. Jitter is ±25 % around the exponential value (simple to reason about and test) rather than "full jitter"; either is defensible.

**Classifying failures.** 4xx other than 408/429 mean "your request is wrong" — retrying wastes capacity and delays the alert, so they dead-letter immediately and can be replayed after the receiver is fixed.

**Lease + fencing instead of heartbeats.** A single `lease_until` timestamp is enough when work is short (5 s timeout vs 60 s lease). Heartbeats/lease extension would be needed for long jobs. The fenced `UPDATE ... WHERE locked_by AND attempt_count` makes lost-lease writes harmless.

**Replay creates a new delivery row.** The original attempt history stays immutable (audit trail); the new row has `replay_of`. Double-clicking replay creates two deliveries — deliberate (explicit user action), receivers dedupe by event id.

**HMAC-SHA256 over `timestamp.body`.** Proves origin and integrity with a shared secret, cheap, standard (same shape used by Stripe/GitHub-style webhooks). Timestamp in the message enables replay-window checks. Asymmetric signatures (Ed25519) would let receivers verify without holding a secret that could also forge — a possible upgrade.

**API keys: SHA-256, not bcrypt.** bcrypt protects *low-entropy human passwords* from offline guessing. These keys are 192 random bits; guessing is infeasible, and a fast hash keeps per-request auth cheap. A server-side pepper (HMAC key) would add defence if the DB leaks alone.

**Fixed-window rate limiting in PostgreSQL.** Atomic, no new infrastructure, per-tenant. Weakness: boundary bursts (≤2×), one DB write per request. At scale: token bucket in Redis or at the gateway.

**Plaintext endpoint secrets.** The service must be able to sign, so it needs the secret. Encrypt at rest with an envelope key from a secret manager for real deployments.

**Local-first, EC2-only AWS option.** Zero budget: Docker Compose is the primary deployment. AWS is a separate exercise using the smallest moving parts (one instance; Postgres in a container *or* RDS if you verify the cost).

**Why not Kubernetes / ECS / Terraform now?** They add concepts and cost that don't help demonstrate the reliability core. ECS/Fargate is the natural next step once you need rolling deploys and autoscaling; Terraform once the environment must be reproducible.

**What would change at 100× traffic?**
1. Measure first (k6 + `pg_stat_statements`); the likely bottleneck is write volume on `deliveries` and `delivery_attempts`.
2. Split the claim query's OR into two statements; tune `autovacuum` aggressively on `deliveries` (high churn); batch-claim larger sets.
3. Partition `delivery_attempts` by time and archive old rows; keep `deliveries` small by moving finished rows out.
4. Add `LISTEN/NOTIFY` (or shorter polling) to cut latency; add PgBouncer.
5. Per-endpoint concurrency limits and circuit breakers so one dead customer cannot occupy all workers.
6. Rate limiting to Redis/gateway; read replicas for the dashboard.
7. If still insufficient, put a real broker (SQS/Kafka) in front and keep Postgres as the system of record.
