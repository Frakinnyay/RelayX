# Security review (self-audit, not a penetration test)

| Threat | Mitigation in code | Where | Residual risk |
|---|---|---|---|
| Auth bypass | Every `/api/v1` route except tenant creation sits behind `authenticate`; `401` is identical for missing/unknown/revoked keys | `api/routes.ts`, `middleware.ts` | `/metrics` and `/health` are unauthenticated unless `METRICS_TOKEN` is set → don't expose publicly |
| Insecure API keys | 192-bit random, only SHA-256 hash stored, shown once, rotation revokes old key | `repositories/apiKeys.ts` | no key expiry / scopes |
| Authorization bypass / tenant leakage | all queries take `tenant_id`; endpoint ownership checked in the ingest transaction; tests prove tenant B gets 404/400 for A's ids | `repositories/*`, `api.test.ts` | worker loads by delivery id (internal) |
| SQL injection | parameterised queries only; no string-built SQL with user data (the only interpolation is a fixed column list constant and the test DB name, validated by regex) | all repos | — |
| Command injection | no shell/child_process use | — | — |
| XSS | React escapes output; payloads rendered via `JSON.stringify` inside `<pre>`; Helmet headers on the API | `web/`, `api/app.ts` | Swagger UI route is outside Helmet CSP (needs inline scripts) |
| CSRF | API uses `Authorization` headers, not cookies, so browsers don't attach credentials automatically | — | key held in `sessionStorage` (XSS would expose it) |
| **SSRF** (outbound requests to attacker-chosen URLs) | (1) create-time check: https only (http only when `ALLOW_PRIVATE_WEBHOOK_TARGETS=true`), no credentials, no localhost/.internal/.local, no private/link-local/metadata IP literals incl. IPv6 & v4-mapped; (2) re-check before every delivery; (3) custom DNS `lookup` rejects hostnames that resolve to private ranges and connects to the *validated* IP (defeats DNS rebinding); (4) redirects never followed; (5) hard timeout; response body discarded | `domain/ssrf.ts`, `worker/httpClient.ts` | no allow-list / egress firewall; IPv6 edge ranges are best-effort; **add VPC egress rules in production** |
| Malicious webhook URLs (ports, slow-loris) | timeout 5 s, no body reading | `httpClient.ts` | arbitrary public ports allowed (can port-scan public hosts) |
| Secret leakage | secrets never logged; endpoint secret only in creation response; error handler returns generic 500; `.env` git-ignored | `logger`, `errors`, `.gitignore` | endpoint secrets are plaintext in DB (needed to sign) → encrypt with KMS/pgcrypto key from a secret manager in production |
| Replay attacks (inbound to receivers) | timestamp in signed message + tolerance; per-attempt re-signing | `signature.ts` | tolerance window; receivers should also dedupe event ids |
| Rate-limit bypass | per tenant, keyed by authenticated tenant (not IP/header), atomic | `rateLimit.ts` | unauthenticated endpoints (`/health`) not limited; tenant creation protected by admin token only |
| Unsafe logging | request logs contain route pattern, status, tenant id; never headers/bodies | `middleware.ts` | `tenant id` and event ids are logged (non-secret) |
| DoS via large bodies | `express.json({limit: 256 KB})` → 413 | `app.ts` | no connection-level limits (put a reverse proxy in front) |
| Timing attacks on admin token | both sides hashed then `timingSafeEqual` | `middleware.ts` | — |

Production checklist: HTTPS in front (Caddy/nginx/ALB), `ALLOW_PRIVATE_WEBHOOK_TARGETS=false`, set `METRICS_TOKEN`, strong `ADMIN_TOKEN`, no public Postgres port, run containers as non-root (the image uses `USER node`), rotate demo credentials (never run the seed in production).
