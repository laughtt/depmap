# GitLab integration

Everything runs locally: a mock GitLab, the depmap API, CI jobs under gitlab-ci-local, and a flow simulator in place of the Duo runtime. The clients speak real GitLab v4 REST, so going live means changing `GITLAB_URL` and the token, plus the UI steps at the end of this page.

## How the local stack maps to gitlab.com

| On gitlab.com | Locally | Where |
|---|---|---|
| `gitlab.com/api/v4` (projects, files, tree, commits, MRs, notes, labels, uploads, issues, jobs, pipelines) | in-memory mock on `:8929`, the same paths and JSON shapes | `server/src/gitlab/mock.ts` |
| OAuth app with PKCE (`/oauth/authorize`, `/oauth/token`) | consent page; S256 verified | mock |
| Group `acme`: `acme/shop` (id 1), `acme/admin` (id 2) | built from `demo/`; branches `main`, `chalk-5`, `debug-4.3.7`, `ms-override`, `deps-sept-8`; MRs !1 to !4 | mock |
| Human `demo` (Owner), flow service account `ai-depmap-acme` | `glpat-*` maps to demo, `glpat-ai-depmap*` maps to the service account | mock |
| The MR page | `http://localhost:8929/view`, which renders notes with `marked` | mock |
| GitLab Runner | `gitlab-ci-local --force-shell-executor` | `scripts/e2e-gitlab.mjs` |
| Runner reporting job logs to GitLab | jobs register their own trace: `POST /mock/jobs` when `GITLAB_MOCK_JOBS=1` | `ci/depmap-lib.mjs` |
| Duo flow (catalog item, v1 YAML) | the same YAML, walked by a simulator | `flows/depmap.flow.yml`, `flows/simulate.ts` |
| Mention trigger | a note with `@depmap` by a human starts the simulator, goal `Input: <note>\nContext: {MergeRequest IID: n}` | mock |
| Flow start over REST, `POST /api/v4/ai/duo_workflows/workflows` | records the workflow and spawns the simulator with the service-account token | mock |
| Model chosen by the group owner (Sonnet 5.5 by default) | `LLM_MODE=mock` (deterministic) or `LLM_MODE=claude` with `ANTHROPIC_API_KEY` (`claude-sonnet-5-5`) | simulator |

## Run it
```sh
pnpm dev:mock                               # mock GitLab on :8929, viewer at /view
node scripts/e2e-gitlab.mjs --keep          # full E2E; --keep leaves the mock running for the viewer
node flows/simulate.ts --validate           # schema check of the flow YAML
pnpm --filter server exec vitest run test/gitlab.test.ts
```
The E2E needs the API on `:8787` (it starts `server/src/api/main.ts` in replay mode if the API is down) and Postgres from `docker compose`. It writes `test-results/e2e-gitlab.json`.

## The pipeline (`ci/templates/depmap.gitlab-ci.yml`)
Include it in any npm project and add a `depmap` stage. The template has three jobs:

1. **`depmap:scan`** runs on MR and default-branch pipelines.
   1. It applies human decisions from MR comments first. Bots and depmap's own notes are ignored. The commands are:
      - `/depmap accept <pkg@version> <N>d: <reason>` accepts the package until the time limit;
      - `/depmap pin <pkg@version>: <reason>` records a pin.
   2. It sends the lockfile, `package.json` and up to 200 JS/TS sources to `POST /api/scan`, with the MR's base sha.
   3. It writes `depmap.json`, and the CycloneDX SBOM when the API serves one.
   4. It prints a compact receipt between `BEGIN_DEPMAP_JSON` and `END_DEPMAP_JSON` as its last output. The receipt is under 100 KB, well inside the 150 KiB tail that `get_job_logs` returns.
2. **`depmap:gate`** fails while a red package has no decision. Its output lists the reasons and the commands to accept or pin.
3. **`depmap:report`** runs on MRs only, even when the gate failed (`when: always`).
   - It renders the map (1200×700, headless Chrome) and uploads it.
   - It creates or updates one note, marked `<!-- depmap:report -->`. The note has:
     - the gate status and counts;
     - the map image;
     - the changed packages;
     - the red packages, with reasons, links and the attack fingerprint;
     - the upgrade impact (verdict, `file:line`, code, problem, fix, alternatives);
     - how to proceed.
   - It sets the scoped label `depmap::red|amber|green`.
   - When the gate fails and `DEPMAP_START_FLOW=1`, it starts the flow over REST, with the pipeline and job ids in the goal.

CI does all the crawling, so it spends 0 GitLab credits. Only the flow uses credits: one reader and one investigator run per failed gate or mention, at 3.2 calls per credit on Sonnet 5.5. A flow that fails before it completes costs nothing.

`ci/depmap-refresh.mjs` is the scheduled job (`depmap:refresh` in `.gitlab-ci.yml`). It polls the watchers, re-assesses every repo through `POST /api/refresh`, and opens one `security::watch` issue per package that turned red in each affected project. It dedupes by title.

## The flow (`flows/depmap.flow.yml`)
`version: "v1"`, `environment: ambient`, two `AgentComponent`s:
- **reader** (`get_merge_request`, `gitlab_api_get`, `get_job_logs`) finds the MR and the `depmap:scan` job, and returns the receipt JSON, or `SKIP`.
- **investigator** (`create_merge_request_note`) handles two cases:
  - **A failed gate:** it explains each undecided red package: what happened, what the fingerprint means, and the safest action (pin the replaced version or wait out the cooldown).
  - **A mention:** it explains the effect of the `/depmap` decision the human typed.

A conditional router sends `SKIP` to `end`. The simulator validates the YAML first: unknown component types, missing prompts, unknown router targets, tools it cannot run, and a bad `entry_point` are all errors. It then walks `flow.entry_point` through the routers and logs every tool call.

## Going live on gitlab.com
1. **Create a PAT** with `api` scope.
2. **Check your role** in the project. A project created in a group inherits your group role, so check that it is Maintainer or Owner.
3. **Set CI/CD variables:**
   - `DEPMAP_API_URL` and `DEPMAP_APP_URL` (the Cloud Run URL);
   - `GITLAB_TOKEN` (masked; a project access token with `api` scope, so notes come from a bot user);
   - `DEPMAP_START_FLOW=1`.

   `GITLAB_URL` defaults to `CI_SERVER_URL`.
4. **Serve the CI scripts.** The template downloads them from `$DEPMAP_SCRIPTS_URL` (default `$DEPMAP_API_URL/ci`) unless `$DEPMAP_CI_DIR` already has them.
5. **Turn on Duo:** in Settings > GitLab Duo, check the CI/CD runner row.
6. **Create the flow:** in AI > Flows > New flow, paste `flows/depmap.flow.yml`, then Managed > Enable. Then add the triggers:
   - **Mention:** the service account gets an `@` handle; use it in place of `@depmap`.
   - **Pipeline events:** Failed.

   Triggers need Premium/Ultimate and the Maintainer/Owner role, and only a human action fires them.
7. **If triggers are not allowed,** keep `DEPMAP_START_FLOW=1` and set `DEPMAP_FLOW_CONSUMER_ID` (the flow's catalog consumer id). The report job then starts the flow through `POST /api/v4/ai/duo_workflows/workflows`. That is the path the local E2E tests.
8. **Schedule the world refresh:** add a pipeline schedule on `main`. It runs `depmap:refresh`, and the schedule owner is the pipeline user.
9. **Configure the flow runtime:** `.gitlab/duo/agent-config.yml` (image `node:22`, no network allowlist) is read from the default branch.

The GraphQL mutations that could automate step 6 (`aiCatalogFlowCreate`, `aiCatalogItemConsumerCreate`, `aiFlowTriggerCreate`) are Experiment status. The UI path above is the reliable one.

## Local caveats
- macOS ships bash 3.2, while gitlab-ci-local copies artifacts with `shopt -s globstar` (bash 4+). The E2E puts a small `bash` shim on gitlab-ci-local's PATH that drops `globstar`; the template's artifact paths do not use `**`.
- gitlab-ci-local reports `CI_PROJECT_DIR=/builds/...` even with the shell executor, so the scan reads the working directory. Runners always start jobs there.
- The replay of 2025-09-08 runs at 13:30 UTC (only the cooldown makes chalk and debug red, with no fingerprint yet) and again at 18:00 UTC (the OSV `MAL-` records are public, and the chalk/debug 2025 fingerprint matches 4 of 4 signals).
