# 5–10 minute demo script

Prep: `docker compose up --build -d`, open http://localhost:5173 (sign in with the demo key), have http://localhost:3000/docs and `docker compose logs -f worker` visible in another window.

1. **(30 s) Pitch.** "Webhooks fail. RelayX makes sure events still arrive — exactly the situation I'll break on purpose."
2. **Dashboard & endpoint (30 s).** Show the seeded endpoint in *Endpoints*; mention secret shown once, URL validated against SSRF.
3. **Healthy delivery (45 s).** *Send 1 event* → SUCCESS. Click it: one attempt, 200, signature valid in the receiver log.
4. **Break the receiver (30 s).** *Fail 2 min*. Send 5 events.
5. **Show failures (60 s).** Statuses → RETRY_WAITING; receiver log: 500 / timeout / 500 / 503. Worker log lines `delivery_attempt_finished` with `retryInMs`.
6. **Show backoff (60 s).** Open an event: attempts at ~5 s, ~15 s, ~45 s… *"Jitter means they don't all retry on the same tick — that avoids retry storms."*
7. **Idempotency (45 s).** Swagger/curl: same `Idempotency-Key` twice → 202 then 200 `idempotentReplay`. *"Enforced by a unique index, tested with 25 concurrent requests."*
8. **Crash recovery (60 s, optional but impressive).** `docker compose kill worker` mid-delivery, then `docker compose up -d worker`; point out the job continues after its lease expires (lower `LEASE_DURATION_MS` before the demo for speed, e.g. 15000 on the worker service).
9. **Recovery (45 s).** *Heal now* (or wait). Events turn SUCCESS; timeline shows failed attempts then success.
10. **Dead letter + replay (60 s).** Add endpoint `http://receiver:4000/nope` → 404 → DEAD_LETTERED immediately (no retries: "retrying a 404 won't help"). Fix: *Replay* creates a new delivery; original history untouched.
11. **Duplicates (30 s).** Replay a SUCCESS delivery: receiver card shows "duplicate delivery" — *"at-least-once; the receiver dedupes on event id."*
12. **Metrics (30 s).** http://localhost:3000/metrics → `relayx_queue_depth`, `relayx_delivery_attempts_total`.
13. **Scale (30 s).** `docker compose up -d --scale worker=3`; mention SKIP LOCKED and show the concurrency test.
14. **Architecture close (60 s).** Show the diagram in `docs/architecture.md`: API → Postgres queue → workers; trade-offs: why Postgres, why at-least-once, what changes at 100×.

Tips: rehearse once; reset between runs with *Reset log* and `docker compose down -v`.
