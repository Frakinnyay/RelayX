# Complete Setup Guide (beginner friendly, zero cost)

You will: install 3 free tools → start the whole system with one command → run the checks → do the chaos demo → (optionally) run load tests.
Nothing here costs money. AWS is optional and covered separately.

## 0. Words you need (2-minute glossary)
- **Docker**: runs programs in isolated "containers", so you don't install PostgreSQL etc. on your PC.
- **Image**: the recipe/package of a program. **Container**: a running copy of an image.
- **Docker Compose**: starts several containers together from one file (`docker-compose.yml`).
- **PostgreSQL**: the database. In this project it is *also* the job queue.
- **Migration**: a SQL file that creates/changes database tables.
- **Worker**: a background program that delivers webhooks. **API**: the HTTP server that accepts events.

## 1. Install tools (one time)
1. **Git** — https://git-scm.com/downloads (Windows: also gives you *Git Bash*, used for `.sh` scripts).
2. **Node.js 22 LTS** — https://nodejs.org (check: open a terminal, run `node -v` → `v22.x`).
3. **Docker Desktop** — https://www.docker.com/products/docker-desktop. Windows: accept WSL 2 installation, reboot, start Docker Desktop and wait until it says "running". Check: `docker --version` and `docker compose version`.
   - Docker Desktop is free for personal use and education; verify the current terms on Docker's site if you use it at a company.
4. *(Optional, for load tests)* **k6** — https://k6.io/docs/get-started/installation/ (free, open source). Or use the Docker image shown in step 8.

## 2. Unzip and open the project
```bash
unzip RelayX.zip          # or right-click → Extract All on Windows
cd RelayX
git init && git add . && git commit -m "Initial RelayX"     # optional, but you want this on GitHub anyway
```

## 3. Start everything with Docker (the easiest path)
```bash
docker compose up --build
```
What happens, in order: PostgreSQL starts → a one-shot `migrate` container creates the tables and a demo tenant → `api`, `worker`, `receiver`, `web` start.
The first build downloads images and npm packages (a few minutes). **If the build fails, copy the error into the chat.**

Open:
| What | URL |
|---|---|
| Dashboard | http://localhost:5173 (sign in with `rx_demo_local_key_0123456789abcdef`) |
| API docs (Swagger) | http://localhost:3000/docs |
| Health / metrics | http://localhost:3000/health · http://localhost:3000/metrics |
| Receiver simulator state | http://localhost:4000/control/state |

Stop: `Ctrl+C`, then `docker compose down` (add `-v` to also delete the database data).
Run in background: `docker compose up --build -d`; logs: `docker compose logs -f worker`.
More workers: `docker compose up --build -d --scale worker=3`.

## 4. First manual test (curl)
```bash
KEY=rx_demo_local_key_0123456789abcdef
EP=$(curl -s -H "Authorization: Bearer $KEY" localhost:3000/api/v1/endpoints | python3 -c "import sys,json;print(json.load(sys.stdin)['data'][0]['id'])")
curl -i -X POST localhost:3000/api/v1/events -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"eventType\":\"order.created\",\"endpointId\":\"$EP\",\"payload\":{\"orderId\":\"123\",\"amount\":1499},\"idempotencyKey\":\"order-123\"}"
```
Run the same command again: you get HTTP 200 and `"idempotentReplay": true` with the same event id. (PowerShell users: use Git Bash for these snippets, or the dashboard's *Send test event* button.)

## 5. Run the automated checks (this is what you report back to me)
You need the database for the integration tests:
```bash
docker compose up -d postgres
bash scripts/verify.sh
```
It runs install, ESLint, TypeScript type check, unit tests, integration tests (queue concurrency, worker, API), build for backend and web, and prints a PASS/FAIL summary.
Without Git Bash/WSL, run by hand:
```bash
cd backend && npm install && npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build
cd ../web && npm install && npm run build
```
After the first `npm install`, **commit the generated `package-lock.json` files** (`backend/` and `web/`); the GitHub Actions workflow uses them (`npm ci`).

End-to-end check against the running Docker stack:
```bash
docker compose up --build -d
bash scripts/smoke.sh
```

## 6. Run without Docker for the apps (for development)
Keep PostgreSQL in Docker (`docker compose up -d postgres`), run the apps with Node in three terminals:
```bash
cd backend && cp ../.env.example .env        # Windows: copy ..\.env.example .env
npm install
npm run migrate && npm run seed              # tables + demo tenant
npm run dev:api                              # terminal 1  → http://localhost:3000
npm run dev:worker                           # terminal 2
npm run dev:receiver                         # terminal 3  → http://localhost:4000
cd ../web && npm install && npm run dev      # terminal 4  → http://localhost:5173
```
(The `npm run dev:*`, `migrate` and `seed` scripts load `backend/.env` automatically via Node's `--env-file-if-exists`. Requires Node 22.9+ — that is why Node 22 LTS is recommended.)
Tip: in this mode the endpoint URL to use is `http://localhost:4000/webhook` (the seed uses it by default).

## 7. The chaos demo (the main portfolio demonstration)
1. Dashboard → *Send 1 event* → watch it become **SUCCESS**.
2. *Fail 2 min* on the receiver card. Send 3–5 events.
3. Watch statuses go **RETRY_WAITING**, "next retry" countdowns grow (≈5 s, 15 s, 45 s, 2 min ± jitter), receiver log shows 500 / timeout / 503.
4. Wait for the failure window to end (or *Heal now*): events turn **SUCCESS**. Click an event for the attempt timeline.
5. Make one event fail permanently: Endpoints tab → add an endpoint whose URL path doesn't exist on the receiver? (Receiver only serves `/webhook`; a URL such as `http://receiver:4000/nope` returns 404 → permanent failure → **DEAD_LETTERED**, no retries.) Use the Dead-letter tab → *Replay*.
Full script: [DEMO_SCRIPT.md](DEMO_SCRIPT.md).

## 8. Load tests (k6)
First raise the demo tenant's rate limit (it already is 100000/min in the seed). Then:
```bash
k6 run -e RATE=100 -e DURATION=30s load-tests/ingest.js
k6 run load-tests/idempotency.js
k6 run -e N=1000 load-tests/delivery-throughput.js
```
No k6 installed? `docker run --rm -i --add-host=host.docker.internal:host-gateway -e API_URL=http://host.docker.internal:3000 -v "$PWD/load-tests:/s" grafana/k6 run /s/ingest.js`
Interpretation and what to record: [PERFORMANCE_TESTING.md](PERFORMANCE_TESTING.md).

## 8b. Windows PowerShell notes (tested on Windows PowerShell 5.1)
- The zip may unpack into `RelayX\RelayX`; run commands from the inner folder that contains `docker-compose.yml`.
- PowerShell 5.1 has no `&&`: run commands one per line.
- If `npm install` says scripts are disabled: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`.
- `scripts/verify.sh` and `scripts/smoke.sh` need Git Bash/WSL (smoke also needs Python); on plain PowerShell run the npm commands from step 5 by hand.
- The database is published on **localhost:5433** (not 5432) so it cannot clash with a PostgreSQL already installed on Windows. Inside Docker it is still 5432.
- Docker Desktop with little memory (< 4 GB): raise it in Settings → Resources if builds are killed.
- Verified on a real machine: unit tests (88), integration tests (45) and the full Docker stack with the chaos demo all passed.

## 9. Troubleshooting
| Symptom | Fix |
|---|---|
| `port is already allocated` (5433/3000/4000/5173) | Stop the other program using it, or change the left side of the port mapping in `docker-compose.yml`. |
| Integration tests: "Cannot reach PostgreSQL" | `docker compose up -d postgres`, wait ~5 s. |
| Dashboard shows "Receiver not reachable" | Receiver container not running: `docker compose ps`. |
| Events stay PENDING | Worker not running: `docker compose logs worker`. |
| `docker compose` not found | Update Docker Desktop (needs Compose v2). |
| Changed code but Docker shows old behaviour | `docker compose up --build`. |

## 10. Put it on GitHub
Create an empty repo on github.com (no README), then:
```bash
git remote add origin https://github.com/<you>/relayx.git
git branch -M main && git push -u origin main
```
The CI workflow (`.github/workflows/ci.yml`) then runs automatically (free for public repos; private repos have a monthly free-minute allowance — verify current limits). Commit the lockfiles first (step 5).

## 11. Optional: AWS
Not needed. If you want the cloud exercise: [AWS_DEPLOYMENT_OPTIONAL.md](AWS_DEPLOYMENT_OPTIONAL.md) — **read [COST_AND_FREE_TIER_GUIDE.md](COST_AND_FREE_TIER_GUIDE.md) first.**
