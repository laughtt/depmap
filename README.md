# depmap: a live dependency map with supply-chain gates

*(Working name.)* Every dependency down to the bottom of the tree, kept as **state per commit**, coloured by behaviour signals, advisories and security watchers. A GitLab Duo flow investigates the red ones, and an upgrade-impact advisor tells you exactly which lines of *your* code a version bump breaks.

Built for the GitLab **Life After Code** hackathon. Path A, Supervised, MIT.

- **Why:** on 8 Sept 2025, chalk/debug (~2B weekly downloads) shipped malware for about two hours, and no scanner knew for the first hour. See `docs/SUBMISSION.md`.
- **Stages:** all nine DevSecOps stages, in `docs/STAGES.md`.
- **Sustainability:** an SCI receipt per scan, in `docs/GREEN.md`.

## Architecture
```
GitLab MR ──CI──▶ depmap:scan ──▶ API (Hono, Node) ──▶ Postgres (facts per package@version, graph per lockfile hash, snapshots)
            │        ├─ scanner: lockfile (npm/pnpm) → graph → registry facts → OSV + GitHub malware → watchers → rules → fingerprints
            │        └─ advisor: oxc call sites + tarball .d.ts (TypeScript compiler) + changelog → NEEDS_CHANGE / REVIEW / NO_CHANGE / PATH_ONLY
            ├─ depmap:gate   fails on undecided reds; `/depmap accept pkg@ver 7d: reason` notes clear it (with expiry)
            ├─ depmap:report map PNG + one MR note (updated in place) + labels; starts the Duo flow on reds
            └─ schedule      watchers poll + world refresh → issues in every affected repo; Pages security page; CycloneDX SBOM
Browser: Vite + TS ── Rust→WASM graph core (layout, paths, diff; 50k nodes in ~7 ms) ── sigma.js WebGL ── IndexedDB layout cache
```

| Path | What |
|---|---|
| `crates/graph-core` | Rust/WASM: binary graph codec, stable radial layout, paths to root, diff (`docs/CONTRACT.md`) |
| `server/src/scanner` | lockfiles, registry facts, OSV, rules, fingerprints, scan, refresh, SCI meter |
| `server/src/advisor` | upgrade-impact advisor |
| `server/src/watchers` | security watchers: GitHub malware advisories, Aikido, StepSecurity, Wiz, Snyk, OpenSSF, CISA |
| `server/src/connector` | GitLab connector: PAT or OAuth with PKCE; tokens encrypted with AES-256-GCM |
| `server/src/gitlab` | local GitLab stand-in (REST v4 shapes, OAuth, uploads, MR viewer, flow start) |
| `web/` | the map UI |
| `ci/`, `ci/templates/` | CI scripts and an includeable template for any npm/pnpm project |
| `flows/` | the Duo flow (v1 YAML) and its local simulator |
| `deploy/` | Dockerfile (same image locally and on Cloud Run), `cloudrun-deploy.sh` |

## Run it locally (no cloud needed)
One command: `scripts/demo.sh`. It starts Postgres, seeds the demo timeline, and runs the API + UI (:8787) and the local GitLab (:8929/view). Or step by step:
```
pnpm install
pnpm db:up                                   # Postgres 17 in Docker on :5433
pnpm build:wasm && pnpm build:web
DATA_MODE=replay ADVISORY_FEED=fixtures/feed/simulated-advisory.json node scripts/seed-demo.ts --reset
DATA_MODE=replay node server/src/api/main.ts # API + UI on http://localhost:8787
node server/src/gitlab/mock.ts               # local GitLab on http://localhost:8929 (/view shows the MRs)
```
- **`DATA_MODE`:** `replay` uses recorded public data in `fixtures/` (offline and deterministic), `record` fetches what's missing, and `live` always fetches.
- **Scan any project on disk** (read-only): `node scripts/scan-local.ts ../my-app`.
- **Export the GitLab Pages security site:** `node scripts/export-pages.ts public`.

## Tests
`pnpm test:all` runs everything and writes `test-results/summary.json`:
- Rust unit tests;
- server tests (vitest, against a separate `depmap_test` database);
- Playwright UI tests (mock and live);
- the GitLab end-to-end MR scenarios.

## Going live on GitLab.com and Cloud Run
See `docs/GITLAB.md` (flow, triggers, CI variables) and `deploy/cloudrun-deploy.sh` (Cloud Run plus Cloud SQL in `europe-north1`).
