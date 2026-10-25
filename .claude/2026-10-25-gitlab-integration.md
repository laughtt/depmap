# GitLab integration layer (local)

## What
- `server/src/gitlab/mock.ts`: in-memory GitLab v4 (Hono, :8929). It covers auth (PAT and OAuth PKCE), projects built from `demo/`, files, tree and commits, MRs, notes, labels, uploads, issues, jobs and pipelines, and the Duo workflow start (which spawns `flows/simulate.ts`). It also emulates the mention trigger and serves a `/view` HTML viewer, plus the `/mock/*` test helpers.
- `ci/*.mjs`: scan (applies `/depmap` decisions, then scans, then prints the receipt block last), gate, render (playwright-core with the Chrome channel), post (a single upserted note, a label and the REST flow start), refresh (issues per flipped red), sbom. Shared helpers live in `ci/lib.mjs`.
- `ci/templates/depmap.gitlab-ci.yml` (includeable), the app's `.gitlab-ci.yml`, `.gitlab/duo/agent-config.yml`.
- `flows/depmap.flow.yml` (v1: reader → investigator) and `flows/simulate.ts` (validates the YAML and walks the routers, with `LLM_MODE=mock|claude`; the tools hit `GITLAB_URL`).
- `scripts/e2e-gitlab.mjs`: gitlab-ci-local on temp git repos per scenario, with a fallback to running the scripts directly.
- `server/test/gitlab.test.ts`, `docs/GITLAB.md`.

## Flow
MR pipeline → `depmap:scan` (decisions from notes → `POST /api/scan` → `depmap.json` and the `BEGIN_DEPMAP_JSON` block) → `depmap:gate` → `depmap:report` (PNG → upload → note upsert → label → if the gate failed, start the flow through REST). The flow reads the job log, extracts the block and posts an investigation note as the service account.

## Decisions
- The template fetches the scripts from `$DEPMAP_SCRIPTS_URL` when `$DEPMAP_CI_DIR` is absent. This needs the API to serve `/ci/*.mjs` (requested from the API owner).
- The E2E pins `DEPMAP_AS_OF` for every scenario (the seed dates). Otherwise today's advisories turn MR !1 and !2 red.
- The E2E deletes its own "replay demo" decisions and events through the DB before running, because the API has no delete endpoint.
- Decision commands are deduped against the decision events (the reason carries the note reference), so a pipeline re-run doesn't extend an expiry.
- The replay runs at 13:30 (cooldown only: the scanner now requires an anomaly before it reports a fingerprint) and then at 18:00 (MAL records, fingerprint 4/4), on the same MR note.
- gitlab-ci-local needs bash 4+ for artifact copying. On macOS (bash 3.2) the E2E puts a shim on its PATH that drops `globstar`.
- Result: E2E 22/22 with every pipeline under gitlab-ci-local (refresh runs directly), and vitest 13/13.
