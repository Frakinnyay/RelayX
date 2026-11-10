# Resume bullets

Numbers below are **your measured results** (hardware: AMD Ryzen 5 5500U, 8 GB RAM laptop, everything co-located, single 30 s runs). Keep the hardware caveat in interviews. Delete any bullet you can't explain. Do **not** mention AWS unless you actually deploy there.

- Built **RelayX**, an at-least-once webhook delivery platform (Node.js, TypeScript, PostgreSQL) using a database-backed job queue with `FOR UPDATE SKIP LOCKED`, lease-based stuck-job recovery, exponential backoff with jitter, dead-lettering and replay.
- Verified concurrent-worker safety: 10 simultaneous connections claimed 200 jobs with zero duplicates (integration test); 18,879 events processed by 1–3 workers under k6 load with 0 lost and 0 duplicate deliveries.
- Load-tested with k6 on a laptop (Ryzen 5 5500U, 8 GB, all services co-located): sustained **150 events/s at p95 46 ms with 0 errors**, saturating near 200/s; scaling workers from 1 to 3 raised end-to-end delivery from **69 to ≥133 events/s**.
- Found and fixed a **connection-pool deadlock** via load testing (500 simultaneous duplicate-key requests → 467 errors); added a regression test; re-test returned 499/499 correct idempotent responses with 0 errors and exactly one event stored.
- Validated failure handling with chaos experiments: a 2-minute receiver outage under load delivered all 201 events (0 dead-lettered); a SIGKILLed worker's 3 in-flight jobs were recovered after lease expiry (0 lost; 3 expected at-least-once duplicates); graceful SIGTERM left 0 stuck jobs.
- Implemented HMAC-SHA256 request signing with replay-window checks, hashed API-key authentication with rotation, per-tenant atomic rate limiting in PostgreSQL, tenant-scoped queries, and SSRF protection (DNS-pinned outbound requests, private-range blocking).
- Instrumented with structured JSON logs, Prometheus metrics and health checks; built a React dashboard with a receiver simulator to visualise retries and recovery; containerised with Docker Compose; 130+ automated tests (unit + PostgreSQL integration) and a GitHub Actions CI pipeline.
