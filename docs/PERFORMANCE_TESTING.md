# Performance experiments

**No results are included. Every `____` is for you to fill in after running the experiment.** Record your machine (CPU, RAM, Docker Desktop resources), commit hash, and settings next to results — numbers from a laptop running k6, Postgres, API and worker together measure *that laptop*.

Common setup:
```bash
docker compose up --build -d
# tenant rate limit: seed sets 100000/min; verify
docker compose exec postgres psql -U relayx -d relayx -c "select name, rate_limit_per_minute from tenants;"
curl -X POST localhost:4000/control/reset
```
k6 prints `http_reqs` (rate), `http_req_duration` (med = p50, p(95)), `http_req_failed` (error rate).

## Experiment 1 — Ingestion throughput
Command: `k6 run -e RATE=100 -e DURATION=60s load-tests/ingest.js` — repeat with RATE=200, 400, 800.
Expected: p95 stays flat until the API/DB saturates, then latency climbs and `dropped_iterations` appears.
Measure: | RATE | achieved req/s | p50 | p95 | error % | `dropped_iterations` | → ____
Interpret: highest rate with p95 < 500 ms and 0 % errors = comfortable capacity of this setup. Check `docker stats` to see whether API or Postgres is the limit.

## Experiment 2 — p95 latency under concurrent load
Command: `k6 run -e RATE=300 -e DURATION=120s load-tests/ingest.js` (steady). Compare with workers running vs stopped (`docker compose stop worker`) to see whether delivery work affects ingestion.
Expected: small difference (separate processes; shared DB). Record p50/p95/p99 ____.

## Experiment 3 — Worker throughput
Receiver must be healthy. Command: `k6 run -e N=2000 load-tests/delivery-throughput.js` with 1, 2, 4 workers (`docker compose up -d --scale worker=N`) and `WORKER_CONCURRENCY` 5 vs 20.
Measure: deliveries/s end-to-end ____ per configuration; queue depth during the run (`curl -s localhost:3000/metrics | grep queue_depth`).
Interpret: throughput ≈ workers × concurrency ÷ (receiver latency) until DB or receiver limits. The receiver simulator is a single Node process and may itself be the bottleneck.

## Experiment 4 — Receiver outage
`curl -X POST localhost:4000/control/fail -H 'Content-Type: application/json' -d '{"seconds":120}'`, send 200 events (`RATE=20 DURATION=10s ingest.js`), watch `select status,count(*) from deliveries group by 1;` every 10 s.
Expected: events RETRY_WAITING during the outage; after healing everything → SUCCESS, none lost; dead-lettering only if the outage outlasts the retry budget (default delays 5+15+45+120+120 s ≈ 5 min across 6 attempts).
Record: time to drain after heal ____; duplicates seen by receiver ____; dead-lettered ____.
Jitter check: `select date_trunc('second', next_attempt_at) s, count(*) from deliveries where status='RETRY_WAITING' group by 1 order by 1;` → retries should be spread, not one spike.

## Experiment 5 — Kill a worker during processing
Make deliveries slow (`curl -X POST localhost:4000/control/fail ... ` gives 6 s hangs; set worker `DELIVERY_TIMEOUT_MS` high via compose override) , send events, `docker compose kill worker` (SIGKILL, no graceful shutdown), start it again.
Expected: rows stay PROCESSING until `lease_until`, then are reclaimed (`attempt_count` +1); every event ends SUCCESS or DEAD_LETTERED; possible duplicates at receiver.
Compare with graceful: `docker compose stop worker` (SIGTERM) → worker logs `worker_stopping`, jobs finish or are released immediately, no waiting for a lease.
Record: recovery delay after kill ____ s (≈ remaining lease), lost events ____ (must be 0).

## Experiment 6 — Concurrent duplicate idempotency requests
`k6 run load-tests/idempotency.js` → note the printed key, then:
```sql
select count(*) from events where idempotency_key = '<key>';        -- must be 1
select count(*) from deliveries d join events e on e.id=d.event_id where e.idempotency_key='<key>';   -- must be 1
```
Expected: 500 responses (one 202, rest 200), exactly 1 event. Result ____.

## Bonus: query plans
`EXPLAIN (ANALYZE, BUFFERS)` the claim query with 100k PENDING rows (`insert … generate_series`) — record whether `deliveries_claimable_idx` is used and execution time ____.

## Recorded results (measured by the project owner, 7–10 Nov 2026)
**Hardware/setup:** Windows laptop, AMD Ryzen 5 5500U (6 cores), 8 GB RAM (~5.9 GB usable), Docker Desktop VM limited to ~2.8 GB. k6, API, worker(s), PostgreSQL 16 and the receiver simulator **all ran on the same machine** (so numbers measure this laptop, not a production capacity). 1 worker × concurrency 5 unless stated. Each load level ran once for 30 s.

### Experiment 1 – ingestion (`ingest.js`, constant arrival rate)
| Target | Achieved | p50 | p95 | Errors | Dropped iterations |
|---|---|---|---|---|---|
| 50/s | 50.0/s | 15.2 ms | 22.5 ms | 0 % | 0 |
| 100/s | 100.0/s | 15.3 ms | 41.4 ms | 0 % | 0 |
| 150/s | 149.7/s | 14.8 ms | 46.3 ms | 0 % | 8 |
| 200/s | 192.7/s | 71.7 ms | 759.5 ms | 0 % | 118 |
Interpretation: flat latency up to 150 events/s; saturation begins between 150 and 200 events/s on this machine. Delivery check after these runs: 14,878 events sent → 14,878 delivered (receiver: 14,878 received, 14,878 unique, 0 duplicates, 0 failed, 0 bad signatures).
(An earlier run was discarded: the script had sent events to a deliberately broken demo endpoint, see Findings log.)

### Experiment 3 – worker throughput (`delivery-throughput.js`, 2,000 events, healthy receiver)
| Workers | Ingest phase | Total | End-to-end |
|---|---|---|---|
| 1 (concurrency 5) | 10.8 s | 29.2 s | 68.6 events/s |
| 3 (concurrency 5 each) | 10.9 s | 15.0 s | 133.4 events/s |
Interpretation: 1 worker could not keep up with ingestion (it finished ~18 s after ingestion ended). With 3 workers delivery finished ~4 s after ingestion, i.e. the producer (~183 events/s) became the limit, so 133/s is a *lower bound* for 3 workers, not their maximum. Across all runs including the 3-worker run the receiver saw 18,879 events: 0 duplicates, 0 failed (no job was ever delivered twice by concurrent workers).

### Experiment 4 – receiver outage under load
Receiver set to fail for 2 min; 201 events sent at 20/s for 10 s. Ten seconds after sending: 49 PENDING, 5 PROCESSING, 147 RETRY_WAITING. Final: **201/201 SUCCESS** (187 on attempt 4, 14 on attempt 5), 0 dead-lettered, 0 lost. Receiver: 818 requests = 617 failed (500/timeout/503) + 201 succeeded, **0 duplicates**.
Observation: 49 events had not even had a first attempt ten seconds in, because failing attempts (a quarter of them 3 s timeouts) occupied all 5 worker slots – head-of-line blocking by a dead receiver. Mitigations (not implemented): per-endpoint concurrency limits, circuit breaker.
Note on jitter: the spread of `next_attempt_at` values in this run mostly reflects events arriving over 10 s and being on different attempt numbers, so it is not by itself proof of jitter. Jitter evidence: unit test (200 draws → 50+ distinct delays) and a single event's timeline in the dashboard demo (attempt gaps ≈ 5 s, 14 s, 42 s, 92 s vs nominal 5/15/45/120 s ±25 %).

### Experiment 5 – worker killed vs stopped (≈2,200 events at 150/s for 15 s)
| | `docker compose kill worker` (SIGKILL) | `docker compose stop worker` (SIGTERM) |
|---|---|---|
| Rows left PROCESSING | 3 | 0 |
| Recovery | after the 60 s lease expired, restarted worker reclaimed them | none needed (log: shutdown_signal_received → worker_stopping inflight=5 → worker_stopped 13 ms later) |
| Final state | 2,237/2,237 SUCCESS | 2,224/2,224 SUCCESS |
| Deliveries with attempt_count > 1 | 3 | 0 |
| Duplicates seen by receiver | 3 (at-least-once: sent, then crashed before recording) | 0 |
| Events lost | 0 | 0 |

### Experiment 6 – 500 simultaneous identical idempotency requests (50 VUs)
| | Before fix | After fix |
|---|---|---|
| New events created | 1 | 1 |
| Duplicates answered with the original | 33 | 499 |
| Requests failed (500, "timeout exceeded when trying to connect") | 467 | 0 |

## Findings log
- **Connection-pool deadlock (found by Experiment 6, fixed).** 500 simultaneous requests with the same idempotency key on a 10-connection pool: 1 event created (the database guarantee held) but ~466 requests failed with "timeout exceeded when trying to connect". Cause: the duplicate path asked the pool for a second connection while holding the first. Fix: reuse the transaction's connection (`eventService.ts`); regression test `tests/integration/pool.test.ts` (100 duplicates on a 3-connection pool). Re-run after the fix: 1 new event, 499 duplicates answered, 0 errors (see Experiment 6).
- **Load-test endpoint selection (fixed).** Early runs sent events to the newest endpoint, which was a deliberately broken demo endpoint (404 → dead-letter). Scripts now pick the active `/webhook` endpoint.
