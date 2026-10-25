#!/usr/bin/env bash
# Starts the whole local stack for a demo or video recording.
#   UI + API   http://localhost:8787      local GitLab   http://localhost:8929/view
set -euo pipefail
cd "$(dirname "$0")/.."
export DATA_MODE=replay ADVISORY_FEED=fixtures/feed/simulated-advisory.json
docker compose up -d --wait db
[ -f web/src/wasm/graph_core.js ] || pnpm build:wasm
[ -f web/dist/index.html ] || pnpm build:web
[ "${1:-}" = "--keep-data" ] || node scripts/seed-demo.ts --reset
pkill -f 'server/src/api/main.ts' 2>/dev/null || true
pkill -f 'server/src/gitlab/mock.ts' 2>/dev/null || true
node server/src/api/main.ts > /tmp/depmap-api.log 2>&1 &
node server/src/gitlab/mock.ts > /tmp/depmap-mock.log 2>&1 &
until curl -s localhost:8787/api/health >/dev/null && curl -s localhost:8929/view >/dev/null; do sleep 0.5; done
echo "UI + API: http://localhost:8787   ·   local GitLab: http://localhost:8929/view"
echo "MR pipelines: node scripts/e2e-gitlab.mjs   (posts the notes you see in the GitLab viewer)"
