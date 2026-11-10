# API reference

Interactive docs: `http://localhost:3000/docs` (OpenAPI JSON: `/openapi.json`). Base path `/api/v1`. All bodies are JSON.
Errors always look like `{"error":{"code":"INVALID_REQUEST","message":"...","details":[...],"requestId":"..."}}` — never stack traces or SQL.

| Method & path | Auth | Description |
|---|---|---|
| `POST /tenants` | `X-Admin-Token` | create tenant, returns API key **once** |
| `POST /api-keys/rotate` | Bearer | new key, revokes the one used |
| `GET /stats` | Bearer | counts per delivery status |
| `POST/GET /endpoints`, `GET/DELETE /endpoints/:id` | Bearer | manage destinations; `DELETE` deactivates |
| `POST /events` | Bearer, rate limited | ingest event (202 new, 200 idempotent replay) |
| `GET /events`, `GET /events/:id` | Bearer | list / timeline with deliveries + attempts |
| `GET /deliveries?status=`, `GET /deliveries/:id` | Bearer | list / detail |
| `POST /deliveries/:id/replay` | Bearer | new delivery for same event (only SUCCESS / DEAD_LETTERED) |
| `GET /health`, `GET /metrics` | none (metrics optional token) | ops |

Error codes: `UNAUTHORIZED` 401 · `INVALID_REQUEST` 400 · `INVALID_JSON` 400 · `INVALID_WEBHOOK_URL` 400 · `ENDPOINT_NOT_FOUND` 400 · `ENDPOINT_INACTIVE` 400 · `NOT_FOUND` 404 ·
`IDEMPOTENCY_KEY_REUSED` 409 · `INVALID_STATE` 409 · `PAYLOAD_TOO_LARGE` 413 · `RATE_LIMITED` 429 · `INTERNAL_ERROR` 500 · `ADMIN_DISABLED` 503.

## Rate limiting
Applies to `POST /events`, per tenant, **fixed one-minute window** (limit = `tenants.rate_limit_per_minute`, default 120).
Algorithm: `INSERT ... ON CONFLICT (tenant_id, window_start) DO UPDATE SET count = count + 1 RETURNING count` — a single atomic statement; PostgreSQL's row lock serialises concurrent requests so each sees a distinct count (no check-then-act race). `count > limit` → 429 + `Retry-After`; headers `X-RateLimit-Limit/Remaining/Reset` on every response.
Trade-offs: a client can send up to 2× the limit across a window boundary; rejected requests still increment the counter; one write per request (a Redis token bucket would be cheaper at high volume).

## curl examples
```bash
API=http://localhost:3000; KEY=rx_demo_local_key_0123456789abcdef; H="Authorization: Bearer $KEY"

# create a tenant (admin)
curl -X POST $API/api/v1/tenants -H "X-Admin-Token: local-admin-token-change-me" -H 'Content-Type: application/json' -d '{"name":"Acme"}'

# register an endpoint (the secret is returned once)
curl -X POST $API/api/v1/endpoints -H "$H" -H 'Content-Type: application/json' -d '{"url":"http://receiver:4000/webhook","secret":"whsec_demo_local_secret"}'

# send an event, idempotent
curl -X POST $API/api/v1/events -H "$H" -H 'Content-Type: application/json' -H 'Idempotency-Key: order-123' \
  -d '{"eventType":"order.created","endpointId":"<endpoint-id>","payload":{"orderId":"123","amount":1499}}'

# look at it
curl -H "$H" $API/api/v1/events/<event-id>
# dead letters, then replay
curl -H "$H" "$API/api/v1/deliveries?status=DEAD_LETTERED"
curl -X POST -H "$H" $API/api/v1/deliveries/<delivery-id>/replay
# rotate key
curl -X POST -H "$H" $API/api/v1/api-keys/rotate
```
Verifying a signature on the receiving side (Node):
```js
const crypto = require('crypto');
function verify(rawBody, headers, secret) {
  const ts = headers['x-relayx-timestamp'];
  if (Math.abs(Date.now()/1000 - Number(ts)) > 300) return false;
  const expected = 'v1=' + crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(headers['x-relayx-signature'] || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```
