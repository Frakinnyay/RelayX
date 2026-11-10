# Portfolio content

**Title:** RelayX — Reliable Webhook Delivery Platform
**One-liner:** A PostgreSQL-backed webhook delivery service with at-least-once delivery, retries, dead-lettering, idempotency and signed requests.

**Problem.** Applications notify each other with webhooks, but receivers go down, time out, return errors, or receive duplicates. Fire-and-forget HTTP calls lose events during outages.

**Architecture.** Express API validates and durably stores each event plus a delivery job in one transaction. Separate worker processes claim jobs from PostgreSQL with `FOR UPDATE SKIP LOCKED`, send HMAC-signed requests, record every attempt, and schedule retries with exponential backoff and jitter. Expired leases let other workers recover jobs from crashed workers. A React dashboard and a receiver simulator let you inject outages and watch the system recover.

**Key engineering features.** Database job queue with safe concurrency · lease + fencing for crash recovery · idempotency via unique index · retryable vs permanent failure classification · dead-letter queue and non-destructive replay · HMAC signatures with timestamp replay protection · hashed, rotatable API keys · per-tenant atomic rate limiting · SSRF protections · graceful shutdown · Prometheus metrics, structured logs · Docker Compose · CI with PostgreSQL integration tests.

**Stack.** Node.js, TypeScript (strict), Express, PostgreSQL, Zod, React, Vite, Jest, Supertest, k6, Docker, GitHub Actions.

**Measurable results (laptop: Ryzen 5 5500U, 8 GB, all services co-located; single 30 s runs).** Ingestion: 150 events/s at p95 46 ms, 0 errors (saturates near 200/s) · Worker throughput: 69 events/s with 1 worker, ≥133 events/s with 3 · Outage test: 201/201 events delivered after a 2-minute receiver outage, 0 dead-lettered · Crash test: killed worker's 3 in-flight jobs recovered, 0 lost · Concurrency: 18,879 events, 0 duplicate claims · Load testing found and fixed a connection-pool deadlock (467 → 0 errors under 500 simultaneous duplicate requests).

**Screenshots / demo suggestions (take your own).** Dashboard during receiver failure (RETRY_WAITING with countdowns) · event timeline showing 500 → timeout → 503 → 200 · dead-letter queue + replay · Swagger UI · `/metrics` output · terminal showing the concurrency test passing · a 2-minute screen recording of the chaos demo.

**GitHub description (≤ 350 chars).** Reliable webhook delivery platform: PostgreSQL job queue (SKIP LOCKED), at-least-once delivery, exponential backoff + jitter, dead-letter + replay, idempotency, HMAC signing, API keys, rate limiting, SSRF protection. Node/TypeScript, React dashboard, Docker Compose, CI.

**Portfolio paragraph.** RelayX is a backend project built to show how reliable asynchronous delivery works under the hood. Instead of reaching for a managed queue, I used PostgreSQL row locking to build one, then tested the hard parts: concurrent workers never claim the same job, crashed workers' jobs are recovered, duplicate submissions are collapsed by the database, and a receiver outage ends in delivery rather than loss. The project includes a dashboard that lets you break the receiver on purpose and watch retries, backoff and recovery happen live.
