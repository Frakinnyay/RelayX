# Optional AWS Deployment — Verify Current Free-Tier Eligibility Before Proceeding

**The project is complete without this.** Do it only as a learning exercise, and read [COST_AND_FREE_TIER_GUIDE.md](COST_AND_FREE_TIER_GUIDE.md) first (billing alert, teardown). **This guide and `.github/workflows/deploy.yml` have never been executed** — expect small fixes; treat every step as "verify".

Target: one EC2 instance running API + worker + web with Docker; PostgreSQL either **(A) as a container on the same instance (no extra service, recommended for cost)** or **(B) RDS**. Logs to CloudWatch (optional; falls back to `docker logs`).

```
Internet → Security group → EC2 [api | worker | web | postgres(A)] → (B) RDS (private)
                               ↑ images from ECR (or build on the box)
```

## 0. Account safety
1. Create an AWS account (needs a card). Enable MFA on the root user; create an admin IAM user/role for daily work; never use root keys.
2. Billing → Budgets → create a zero-spend or tiny monthly budget with email alerts. Check the Free Tier page.

## 1. Network and instance
1. Region: choose one near you and stay in it.
2. EC2 → Security Groups → create `relayx-sg`: inbound **22 from "My IP" only**, **80** (and later 443) from anywhere if you want a public demo, **3000 only if you need direct API access** (prefer going through a reverse proxy). No other inbound. **Never open 5432.**
3. EC2 → Launch instance: Amazon Linux 2023 or Ubuntu LTS, smallest instance type that your account's free offer covers (check the console's "Free tier eligible" label), 8–16 GB gp3 disk, key pair (download the `.pem`, `chmod 400`), security group `relayx-sg`.
4. Create an **IAM role** for the instance with *only*: `AmazonEC2ContainerRegistryReadOnly` and (if using CloudWatch logging) `logs:CreateLogGroup/CreateLogStream/PutLogEvents` for log group `relayx`. Attach it as the instance profile.

## 2. Prepare the server
```bash
ssh -i relayx.pem ec2-user@<public-ip>
sudo dnf install -y docker git awscli      # Ubuntu: sudo apt install -y docker.io docker-compose-v2 awscli
sudo systemctl enable --now docker && sudo usermod -aG docker $USER && exit   # log in again
# Compose v2 plugin if missing: follow Docker's docs for your distro
mkdir -p ~/relayx
```
Copy `docker-compose.prod.yml` and `scripts/deploy.sh` to `~/relayx/` (`scp`), `chmod +x deploy.sh`.

## 3. Production `.env` on the server (`~/relayx/.env`, never committed)
```
NODE_ENV=production
USE_LOCAL_DB=true                      # option A
POSTGRES_USER=relayx
POSTGRES_PASSWORD=<long random>
POSTGRES_DB=relayx
DATABASE_URL=postgres://relayx:<same password>@postgres:5432/relayx     # option B: the RDS endpoint instead (add ?sslmode=require handling as needed)
ADMIN_TOKEN=<long random>
METRICS_TOKEN=<long random>
CORS_ORIGIN=http://<your-domain-or-ip>
ALLOW_PRIVATE_WEBHOOK_TARGETS=false
REGISTRY=<account>.dkr.ecr.<region>.amazonaws.com
ECR_REPOSITORY=relayx-backend
AWS_REGION=<region>
```
Create the first tenant with the admin endpoint (`POST /api/v1/tenants`) — **do not run the seed** in production.

## 4. Image registry (ECR) — or skip it
Option 1 (ECR): ECR → create private repository `relayx-backend`. Locally: `aws ecr get-login-password | docker login --username AWS --password-stdin <registry>`; `docker build -f backend/Dockerfile -t <registry>/relayx-backend:latest .`; `docker push ...`. ECR has a small free storage allowance — verify.
Option 2 (zero extra service): `git clone` the repo on the instance and `docker compose build` there (change `image:` to `build:` in a copy of the prod compose).

## 5. First deploy
```bash
cd ~/relayx && ./deploy.sh        # pulls images, starts postgres (option A), runs migrations, starts api + worker
curl localhost:3000/health
```
The web container is not in `docker-compose.prod.yml` by default; either add it (build with `VITE_API_URL` pointing at your public API URL) or serve the dashboard locally against the remote API.

## 6. HTTPS
Put Caddy or nginx on the instance (Caddy obtains free Let's Encrypt certificates automatically but needs a domain you control) and proxy 443 → `localhost:3000`. Without a domain, API keys travel over plain HTTP — fine for a short demo with throwaway keys only.

## 7. CloudWatch logs (optional)
`docker-compose.prod.yml` uses the `awslogs` driver (needs the instance role above). Check the log group `relayx` in the CloudWatch console. Verify the free allowance; set retention to 1–3 days.

## 8. CI/CD (GitHub Actions → ECR → EC2)
Workflow: `.github/workflows/deploy.yml` (manual trigger). One-time setup:
1. IAM → Identity providers → add `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`).
2. IAM role for GitHub, trust policy limited to `repo:<you>/<repo>:ref:refs/heads/main`, permissions limited to ECR push on the single repository (`ecr:GetAuthorizationToken` + push actions on that repo ARN).
3. GitHub repo → Settings → Secrets and variables → Actions → add:
| Secret | Meaning |
|---|---|
| `AWS_ROLE_ARN` | the OIDC role above |
| `AWS_REGION` | e.g. `ap-south-1` |
| `ECR_REPOSITORY` | `relayx-backend` |
| `EC2_HOST` | instance public IP/DNS |
| `EC2_USER` | `ec2-user` (or `ubuntu`) |
| `EC2_SSH_KEY` | contents of the private key (create a dedicated key pair; restrict port 22 — note GitHub runner IPs vary, so for a demo either open 22 temporarily or use SSM Session Manager instead) |
4. Actions → *Deploy (optional, manual)* → Run workflow. Verify with `curl http://<ip>:3000/health`.

## 9. Option B: RDS instead of the container
Only if your Free Tier page shows RDS eligibility or you accept the cost. Create PostgreSQL 16, **Public access: No**, a security group allowing 5432 **only from `relayx-sg`**, smallest class, no Multi-AZ, minimal storage, backups retention 1 day. Put its endpoint in `DATABASE_URL` and drop `USE_LOCAL_DB`. Add `sslmode` settings as RDS requires.

## 10. Security recap
Security groups as above; no public DB; secrets only in the server `.env` (or SSM Parameter Store / Secrets Manager — verify pricing); least-privilege IAM (ECR read on the instance, ECR push only for CI); `ALLOW_PRIVATE_WEBHOOK_TARGETS=false`; consider an egress restriction so the worker cannot reach internal AWS addresses (the SSRF code already blocks 169.254.169.254 — also enforce IMDSv2 on the instance).

## 11. Tear down
Follow the checklist in COST_AND_FREE_TIER_GUIDE.md **the same day**.

## Optional Production Upgrade (not required)
ECS Fargate (or EC2 launch type) with separate `api` and `worker` services, ALB + ACM certificate, RDS in private subnets, Secrets Manager, autoscaling workers on queue depth, Terraform for reproducibility. These add recurring cost (ALB, NAT, Fargate); skip unless you have a budget or credits.
