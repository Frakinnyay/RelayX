# Database design

PostgreSQL 16 (works on 13+). Schema: `database/migrations/001_init.sql`.

| Table | Purpose | Notable constraints |
|---|---|---|
| tenants | isolation boundary, holds rate limit | — |
| api_keys | **hash only** of each key, revocable | `key_hash UNIQUE` (also the login lookup index) |
| webhook_endpoints | destination URL + HMAC secret, soft-deactivated | `tenant_id` FK |
| events | the immutable fact "X happened" + payload | **unique `(tenant_id, idempotency_key)` where key is not null** |
| deliveries | the queue: one row = one job | status `CHECK`, `attempt_count`, `next_attempt_at`, lease columns, `replay_of` |
| delivery_attempts | append-only history of every HTTP attempt | `UNIQUE (delivery_id, attempt_number)` |
| rate_limit_buckets | per tenant per minute counters | PK `(tenant_id, window_start)` |

Every read/write that touches tenant data includes `tenant_id = $n` (see `repositories/` — the worker is the only internal reader that goes by delivery id, because it holds a job it claimed).

## Indexes and why
| Index | Query it serves |
|---|---|
| `deliveries_claimable_idx (next_attempt_at) WHERE status IN ('PENDING','RETRY_WAITING')` | the worker's claim query. Partial: finished rows (the vast majority over time) are not in it, so it stays small and hot. |
| `deliveries_lease_idx (lease_until) WHERE status = 'PROCESSING'` | stuck-job recovery branch of the claim query |
| `deliveries_tenant_status_idx (tenant_id, status, created_at DESC)` | dashboard lists, dead-letter queue |
| `deliveries_event_idx (event_id)` | event detail / timeline |
| `events_tenant_idempotency_uq` (unique, partial) | idempotency: correctness (race-proof) **and** speed of the duplicate lookup |
| `events_tenant_created_idx (tenant_id, created_at DESC)` | event list |
| `api_keys.key_hash` unique | authentication lookup on every request |
| `delivery_attempts (delivery_id, attempt_number)` unique | timeline fetch + integrity |

Check them yourself: `EXPLAIN ANALYZE` the claim query from `repositories/queue.ts` after inserting many rows (see PERFORMANCE_TESTING.md). The claim query has an `OR` across two branches; at very high volume you would split it into two statements so each uses exactly one index (noted as a scaling step).

## The claim query
```sql
WITH picked AS (
  SELECT id FROM deliveries
   WHERE (status IN ('PENDING','RETRY_WAITING') AND next_attempt_at <= now())
      OR (status = 'PROCESSING' AND lease_until < now())
   ORDER BY next_attempt_at LIMIT $1
   FOR UPDATE SKIP LOCKED)
UPDATE deliveries d SET status='PROCESSING', locked_by=$2, lease_until=now()+..., attempt_count=attempt_count+1 ...
  FROM picked WHERE d.id = picked.id RETURNING ...;
```
`FOR UPDATE` locks the selected rows until the statement's transaction commits; `SKIP LOCKED` makes other workers pass over locked rows instead of waiting. Because select-and-update happen in a single statement (one implicit transaction), a row is either unlocked-and-pending (claimable) or locked/processing (skipped). Two workers cannot both get the same row. `tests/integration/queue.test.ts` proves it with 10 simultaneous connections and a held row lock.

## Migrations
`backend/src/db/migrate.ts`: applies `*.sql` in filename order, each in a transaction, recorded in `schema_migrations`, guarded by an advisory lock so concurrent starters don't race. Add new changes as `002_*.sql`; never edit an applied file.
