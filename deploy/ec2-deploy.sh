#!/usr/bin/env bash
# Builds the image here (arm64, like the host), ships it over SSH and restarts the stack in /opt/depmap.
#   HOST=user@host KEY=~/.ssh/key.pem deploy/ec2-deploy.sh
# One-time on the host: /opt/depmap/.env with PUBLIC_URL, APP_SECRET, DB_PASSWORD, OAUTH_CLIENT_ID, GITLAB_URL, REQUIRE_LOGIN, DEPMAP_CI_TOKEN.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${HOST:?set HOST=user@host}
KEY=${KEY:?set KEY to the SSH key file}
docker build --platform linux/arm64 -f deploy/Dockerfile -t depmap:latest .
docker save depmap:latest | gzip -1 | ssh -i "$KEY" "$HOST" 'gunzip | docker load'
scp -i "$KEY" deploy/compose.prod.yml "$HOST:/opt/depmap/compose.yml"
ssh -i "$KEY" "$HOST" 'cd /opt/depmap && docker compose up -d --wait && docker image prune -f >/dev/null'
