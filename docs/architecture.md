# Architecture

## 1. System architecture
```mermaid
flowchart LR
  subgraph Clients
    App[Customer's application]
    Dash[React dashboard]
  end
  App -->|POST /api/v1/events| API
  Dash --> API
  subgraph RelayX
    API[Express API<br/>auth, validation, rate limit, idempotency]
    PG[(PostgreSQL<br/>events, deliveries = job queue, attempts)]
    W[Worker processes<br/>1..N]
  end
  API -->|one transaction| PG
  W -->|claim with SKIP LOCKED, record results| PG
  W -->|HTTP POST, HMAC signed| EP[Customer webhook endpoint]
  Dash -.->|demo only| SIM[Receiver simulator]
```
API and workers are **separate processes** sharing only the database. API latency never depends on a customer's server, and workers scale independently.

## 2. Database ER diagram
```mermaid
erDiagram
  tenants ||--o{ api_keys : has
  tenants ||--o{ webhook_endpoints : owns
  tenants ||--o{ events : owns
  tenants ||--o{ rate_limit_buckets : counted_in
  webhook_endpoints ||--o{ events : receives
  events ||--o{ deliveries : "delivered by"
  webhook_endpoints ||--o{ deliveries : targets
  deliveries ||--o{ delivery_attempts : records
  deliveries |o--o| deliveries : replay_of
  tenants { uuid id PK
    text name
    int rate_limit_per_minute }
  api_keys { uuid id PK
    uuid tenant_id FK
    text key_hash UK
    timestamptz revoked_at }
  webhook_endpoints { uuid id PK
    uuid tenant_id FK
    text url
    text secret
    bool active }
  events { uuid id PK
    uuid tenant_id FK
    uuid endpoint_id FK
    jsonb payload
    text idempotency_key
    text request_hash }
  deliveries { uuid id PK
    uuid event_id FK
    text status
    int attempt_count
    timestamptz next_attempt_at
    timestamptz lease_until
    text locked_by
    uuid replay_of FK }
  delivery_attempts { uuid id PK
    uuid delivery_id FK
    int attempt_number
    text outcome
    int status_code
    int duration_ms }
```

## 3. Event lifecycle
```mermaid
sequenceDiagram
  participant C as Client
  participant A as API
  participant D as PostgreSQL
  participant W as Worker
  participant R as Receiver
  C->>A: POST /events (API key, idempotencyKey)
  A->>D: BEGIN; check endpoint belongs to tenant
  A->>D: INSERT event ON CONFLICT DO NOTHING
  A->>D: INSERT delivery (PENDING)
  A->>D: COMMIT
  A-->>C: 202 {eventId, deliveryId}
  W->>D: claim (SKIP LOCKED) → PROCESSING, lease
  W->>R: POST signed body
  R-->>W: 200
  W->>D: attempt row + status SUCCESS (one tx, fenced)
```

## 4. Worker / job lifecycle (state machine)
```mermaid
stateDiagram-v2
  [*] --> PENDING: event accepted / replay
  PENDING --> PROCESSING: claimed
  RETRY_WAITING --> PROCESSING: due and claimed
  PROCESSING --> SUCCESS: 2xx
  PROCESSING --> RETRY_WAITING: timeout / network / 5xx / 408 / 429
  PROCESSING --> DEAD_LETTERED: 400/401/403/404... or attempts exhausted
  PROCESSING --> PROCESSING: lease expired, reclaimed by another worker
  PROCESSING --> RETRY_WAITING: graceful shutdown release (attempt not counted)
  SUCCESS --> [*]
  DEAD_LETTERED --> [*]
```
Illegal transitions throw (`domain/state.ts`) and every UPDATE also has a `WHERE status = 'PROCESSING' AND locked_by = ...` guard. The API cannot set a status; the only mutation is `replay`, which inserts a **new** row.

## 5. Retry lifecycle
```mermaid
flowchart TD
  A[Attempt n] --> B{Result}
  B -->|2xx| S[SUCCESS]
  B -->|400/401/403/404/3xx| P[DEAD_LETTERED immediately]
  B -->|timeout, network error, 5xx, 408, 429| C{n >= max_attempts?}
  C -->|yes| P
  C -->|no| D["delay = min(base × factor^(n-1), max) ± jitter<br/>(and ≥ Retry-After if sent)"]
  D --> E[RETRY_WAITING until next_attempt_at] --> A
```
Defaults: base 5 s, factor 3, max 120 s, jitter ±25 %, 6 attempts → ≈5 s, 15 s, 45 s, 120 s, 120 s.

## 6. CI/CD pipeline
```mermaid
flowchart LR
  Push[push / PR] --> Lint[lint + typecheck]
  Lint --> UT[unit tests]
  UT --> IT[integration tests<br/>PostgreSQL service container]
  IT --> Build[build backend + web]
  Build --> Img[docker build both images]
  Img -. manual, optional .-> Deploy[deploy.yml: OIDC → ECR push → SSH deploy to EC2]
```
## 7. Optional AWS deployment architecture
```mermaid
flowchart TB
  Internet --> SG[Security group: 80/443 public, 22 from my IP only]
  SG --> EC2
  subgraph EC2[Single EC2 instance]
    API[api container] 
    WK[worker container]
    WEB[web container]
    PGC[(postgres container<br/>Option A: zero extra cost)]
  end
  EC2 -. Option B, check pricing .-> RDS[(RDS PostgreSQL<br/>private, only reachable from EC2 SG)]
  EC2 --> CW[CloudWatch Logs]
  ECR[(ECR images)] --> EC2
```
