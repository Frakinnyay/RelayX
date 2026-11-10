-- RelayX schema. PostgreSQL 13+ (gen_random_uuid is built in).

CREATE TABLE tenants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  rate_limit_per_minute integer NOT NULL DEFAULT 120 CHECK (rate_limit_per_minute > 0),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Raw API keys are never stored. key_hash = SHA-256(raw key), hex encoded.
CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_prefix  text NOT NULL,              -- first characters only, for humans to recognise a key
  key_hash    text NOT NULL UNIQUE,       -- UNIQUE index is also the auth lookup index
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id);

CREATE TABLE webhook_endpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url         text NOT NULL,
  description text,
  secret      text NOT NULL,              -- HMAC signing secret (must be recoverable to sign requests)
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_tenant_idx ON webhook_endpoints (tenant_id, created_at DESC);

CREATE TABLE events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id),
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key  text,
  request_hash     text NOT NULL,         -- detects "same key, different body" misuse
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- The database, not application code, guarantees one event per (tenant, idempotency key).
CREATE UNIQUE INDEX events_tenant_idempotency_uq
  ON events (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX events_tenant_created_idx ON events (tenant_id, created_at DESC);

-- A delivery is one unit of work in the queue (the "job").
CREATE TABLE deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id),
  status           text NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','PROCESSING','RETRY_WAITING','SUCCESS','DEAD_LETTERED')),
  attempt_count    integer NOT NULL DEFAULT 0,
  max_attempts     integer NOT NULL CHECK (max_attempts > 0),
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_by        text,                  -- worker id holding the lease
  locked_at        timestamptz,
  lease_until      timestamptz,           -- after this instant another worker may reclaim the job
  last_status_code integer,
  last_error       text,
  replay_of        uuid REFERENCES deliveries(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);
-- Job claiming: partial index contains only rows that are waiting to run, ordered by due time.
CREATE INDEX deliveries_claimable_idx ON deliveries (next_attempt_at)
  WHERE status IN ('PENDING','RETRY_WAITING');
-- Stuck-job recovery: finds PROCESSING rows whose lease expired.
CREATE INDEX deliveries_lease_idx ON deliveries (lease_until) WHERE status = 'PROCESSING';
-- Dashboard / API listing per tenant and status.
CREATE INDEX deliveries_tenant_status_idx ON deliveries (tenant_id, status, created_at DESC);
CREATE INDEX deliveries_event_idx ON deliveries (event_id);

-- Immutable history: one row per attempt. Never updated, never deleted by the app.
CREATE TABLE delivery_attempts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id    uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  outcome        text NOT NULL CHECK (outcome IN ('SUCCESS','RETRYABLE_FAILURE','PERMANENT_FAILURE')),
  status_code    integer,
  error          text,
  duration_ms    integer NOT NULL,
  worker_id      text NOT NULL,
  started_at     timestamptz NOT NULL,
  finished_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id, attempt_number)
);

-- Fixed-window rate limiting counters (one row per tenant per minute).
CREATE TABLE rate_limit_buckets (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (tenant_id, window_start)
);
