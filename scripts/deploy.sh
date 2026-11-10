#!/usr/bin/env bash
# Runs ON the EC2 instance (copied to ~/relayx/deploy.sh). Pulls the new image and restarts the stack.
set -euo pipefail
: "${REGISTRY:?}" "${ECR_REPOSITORY:?}"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
export REGISTRY ECR_REPOSITORY
PROFILE_ARGS=""
if grep -q '^USE_LOCAL_DB=true' .env; then PROFILE_ARGS="--profile localdb"; fi
docker compose -f docker-compose.prod.yml $PROFILE_ARGS pull
docker compose -f docker-compose.prod.yml $PROFILE_ARGS up -d
docker image prune -f
