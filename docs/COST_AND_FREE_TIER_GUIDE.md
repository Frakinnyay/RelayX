# Cost and free-tier guide

## Completely free (locally) — this is the primary way to use the project
| Component | Cost |
|---|---|
| Node.js, TypeScript, React, Vite, Express, Jest, Supertest, ESLint | free, open source |
| PostgreSQL (Docker container) | free, open source |
| Docker Engine / Compose | free; Docker Desktop is free for personal/education use (check current terms if used commercially) |
| k6 (local) | free, open source. Do **not** use k6 Cloud. |
| Metrics (`/metrics`, Prometheus format) and structured logs | free; no hosted monitoring needed. Optional: run Prometheus/Grafana locally in Docker if you want graphs. |
| GitHub + GitHub Actions | public repositories: free; private repositories: monthly free minutes — verify current limits at github.com/pricing |
| No AI API, no SaaS, no paid auth provider is used anywhere. |

You can build, test, demo and put this on GitHub with **zero spending and without an AWS account**.

## Optional: AWS (can cost money — read before touching it)
AWS free-tier rules have changed over time and differ by when your account was created. As of my last check, accounts created on/after mid-July 2025 get a credit-based *Free Plan* (credits with an expiry, and the account is closed/downgraded when they run out unless you upgrade), while older accounts may still have the legacy 12-month free-tier offers. **I cannot see your account.** Before creating anything:
1. Sign in → Billing and Cost Management → **Free Tier** page: see exactly which offers and credits your account has and the expiry dates.
2. Check the pricing pages for each service you plan to use (EC2, EBS storage, public IPv4 address, RDS, ECR, CloudWatch Logs, data transfer).
3. Create a **budget with alerts** *first* (Billing → Budgets → "Zero spend budget" or a $1–5 monthly budget with email alerts).

| Resource | Can it generate charges? | Zero-cost alternative |
|---|---|---|
| EC2 instance (t2/t3.micro or similar) | Yes after free hours/credits; hours are per month across *all* instances | Run locally with Docker Compose |
| EBS volume | Yes beyond the free allowance, **and it keeps costing while the instance is stopped** | delete with the instance |
| Public IPv4 address | Charged hourly for public IPv4 on current AWS pricing (free allowance varies by plan) — verify | none needed locally |
| RDS PostgreSQL | Free-tier eligibility depends on your account and instance class; storage, backups and a Multi-AZ option can all cost | **Postgres in a container on the same EC2** (this repo's default AWS option) |
| ECR | small free storage allowance, then per-GB-month | build the image on the EC2 instance, or GHCR (free for public images) |
| CloudWatch Logs | free allowance for ingestion/storage, then per-GB | `docker compose logs` |
| NAT Gateway, Load Balancer, ECS Fargate, managed monitoring | **Yes, hourly — do not create these** | not needed; this project never requires them |
| Data transfer out | free allowance, then per-GB | — |

## How to avoid surprise bills
- One region, one instance, smallest size. Tag everything `project=relayx`.
- Billing alert **before** launching anything; check the Billing dashboard daily while resources exist.
- Do the AWS exercise in one sitting (an hour or two), screenshot/record the demo, then **tear everything down the same day**.
- Never create: NAT Gateway, load balancer, Elastic IP you don't use, Multi-AZ RDS, extra snapshots.

## Teardown checklist (do all of it)
1. EC2 → Instances → select → *Terminate* (stop is not enough for EBS).
2. EC2 → Volumes: no leftover volumes. EC2 → Elastic IPs: release any.
3. EC2 → Security Groups / Key Pairs: delete the ones you created.
4. RDS (if used) → Databases → Delete; **uncheck** "create final snapshot" or delete the snapshot afterwards; Snapshots → delete manual snapshots.
5. ECR → Repositories → delete `relayx-backend`.
6. CloudWatch → Log groups → delete `relayx`.
7. IAM → delete the deploy role/OIDC provider you created for GitHub.
8. Billing → Bills (next day): confirm $0 and no running services; check *every region* in Cost Explorer.
