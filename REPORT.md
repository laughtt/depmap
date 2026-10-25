# Build report: 25 Oct 2026, local 8-hour build

Everything ran locally: Docker Postgres, the same container that would run on Cloud Run, a local GitLab stand-in and a local Duo flow simulator. Nothing was pushed, no GCP resources were created, and no Duo credits were spent. One local git commit exists in `app/`.

## Start here
```
cd life-after-code/app
scripts/demo.sh                 # Postgres + seeded demo + UI/API :8787 + local GitLab :8929/view
node scripts/e2e-gitlab.mjs     # runs the MR pipelines that post the notes in the GitLab viewer
pnpm test:all                   # every suite → test-results/summary.json
```

## Test results (all green)
| Suite | Result |
|---|---|
| Rust graph core (`cargo test`) | 10 passed, 1 perf test ignored by default |
| Server (vitest, separate `depmap_test` DB) | 33 passed |
| UI, mock data (Playwright, local Chrome) | 10 passed |
| UI, live API | 9 passed, 1 skipped (the 50k synthetic graph exists only in mock mode) |
| GitLab E2E under gitlab-ci-local | 22/22 checks |
| `.gitlab-ci.yml` | validates against GitLab's JSON schema (`gitlab-ci-local --list`) |
| Container (`deploy/Dockerfile`) | builds; serves the API and UI against Postgres on :8080 |

Screenshots:
- `test-results/ui/` (map, drawer, upgrade, scrubber, watchers, connect, render, dig, the 50k map);
- `test-results/gitlab/` (the MR !4 thread, MR !1, the refresh issue).

## What was built
- **Rust → WASM graph core:** a binary codec, a stable radial layout, paths to the root, and diff and search. It lays out **50k nodes / 120k edges in 7–9 ms**, the layout is cached in IndexedDB, and it's built for both the browser and Node.
- **Scanner:**
  - npm **and pnpm** lockfiles;
  - registry facts (trimmed, cached per `package@version`);
  - OSV plus a local advisory feed;
  - rules: cooldown, takeover shape, install scripts, publisher handover, provenance, deprecated, typosquat, unpublished (live scans only), and dev-only build-tool exposure;
  - **attack fingerprints** (chalk/debug 2025, Shai-Hulud 2025, ua-parser-js 2021, event-stream 2018), which need a real anomaly to match.
- **Upgrade-impact advisor** (your new request): per bump, does *our* code need to change?
  - Call sites come from oxc-parser.
  - The API surface comes from both tarballs' `.d.ts` via the TypeScript compiler.
  - It records the module format (ESM-only vs CommonJS), the Node engines constraint and a changelog excerpt.
  - Verdicts: NEEDS_CHANGE (with `file:line`, the fix and alternatives), REVIEW, NO_CHANGE, or PATH_ONLY ("reaches you via a → b") for transitive bumps.
  - The version knowledge is stored per version in the DB (`pv_api`).
- **State per commit** in Postgres: graphs keyed by lockfile hash, frozen colours per snapshot, decisions **with expiry**, events, and a delta per MR. A **world refresh** re-colours every repo when one advisory lands.
- **Security watchers** (your request): GitHub malware advisories, Aikido, StepSecurity, Wiz, Snyk, OpenSSF and CISA.
  - Posts are matched to packages precisely: structured advisories by name; blog posts only when a supply-chain title names the package, or the body says `name@ver` or "the X package".
  - Date-only feed timestamps count as end of day, so a replay never knows early.
- **Repo connector** (your request): a GitLab PAT or **OAuth with PKCE**. Tokens are AES-256-GCM encrypted on the server and never kept in the browser. Import fetches the lockfile, `package.json` and sources through the GitLab API.
- **The UI:**
  - connect, then project list, then import with the **dig** animation;
  - repo list with sparklines;
  - the map: rings for depth, wedges for direct dependencies, WebGL, hover paths;
  - a drawer with Overview, Paths, **Upgrade** and Decision tabs;
  - a time scrubber with replay;
  - compare mode;
  - the Watchers page;
  - a chrome-less render view for the MR images;
  - dark and light themes.
- **GitLab layer:**
  - a local GitLab with v4 REST shapes, OAuth, uploads, MRs, issues, job traces and an MR viewer;
  - CI scripts: scan (applies human `/depmap accept|pin` notes first), gate, render, a post that **updates one note in place**, refresh (opens `security::watch` issues, deduped), and the SBOM;
  - an includeable template;
  - the app's own `.gitlab-ci.yml` (build, test, depmap, package, **Pages security site**, manual Cloud Run deploy);
  - a **v1 Duo flow** (reader + investigator) with a simulator that runs the same YAML against the mock.
- **Prize extras:**
  - all 9 stages mapped (`docs/STAGES.md`);
  - an **SCI carbon receipt** per scan (`docs/GREEN.md`);
  - a CycloneDX SBOM;
  - a GitLab Pages security page;
  - CODEOWNERS on the policy and flow files;
  - the Devpost draft (`docs/SUBMISSION.md`) and video script (`docs/DEMO_SCRIPT.md`).

## Things worth knowing
1. **The Sept 8, 2025 replay is honest.**
   - At 13:30 UTC only the cooldown rule holds chalk@5.6.1 and debug@4.4.2, because no advisory existed yet.
   - By 18:00 the OSV `MAL-` records count, with the 4/4 fingerprint.
   - On Sept 9 the Wiz post (found by the watchers) is linked.
   - Every signal is filtered by when it became public.
2. **Our own tool caught our own fresh installs.** This project's lockfile had hono@4.13.14, seven hours old. Then pnpm's built-in release-age policy **independently refused the same two packages** during the container build. We pinned the previous releases (hono 4.13.13, gitlab-ci-local 4.76.1), and the app is now all green.
3. **Your repos (scanned read-only; the data stayed in a git-ignored `fixtures/local/`):**
   - **softlution-web**, 428 packages, 5 red. `next@16.1.1` has a **CRITICAL unauthenticated RCE** in the Image Optimization API (GHSA-2464-fhr4-w9xw, fixed in 16.4.1).
   - **adtomic**, 640 packages, 17 red. It includes a **CRITICAL Clerk middleware route-protection bypass** (GHSA-vqx2-fgx2-5wq9), a Clerk authorization bypass, and a **drizzle-orm SQL injection** (GHSA-gpj5-g38j-94v9, fixed in 0.45.2).

   These are real, live advisories: worth upgrading regardless of the hackathon.
4. **SCI:** a cold scan of a 428-package app took 29 s and 386 MB (≈0.23 gCO2e at us-east1 intensity). The warm re-scan took **47 ms with zero network**.

## Deviations from the plan
- The server is one `server/` package with folders (scanner, advisor, api, db, watchers, connector, gitlab) rather than separate packages, so Node can run the TypeScript directly with no build step.
- The advisor is fully deterministic: the LLM isn't needed to decide, only to explain. `LLM_MODE=claude` exists in the flow simulator but is **untested**, because no API key was available.
- Added on request: the watchers, the connector with OAuth, the scans of your repos, and the prize extras.

## Still needed from you (going live; see `docs/GITLAB.md`)
1. Pick the **final project name**; "depmap" is a working name.
2. Create the public project in your hackathon group, push, and set the CI variables (`DEPMAP_API_URL`, `GITLAB_TOKEN`).
3. Create the flow from `flows/depmap.flow.yml` (GraphQL `aiCatalogFlowCreate` or AI > Flows), enable it, and add the Pipeline and Mention triggers. You need the Maintainer or Owner role.
4. Optional GCP bonus: `GCP_PROJECT=… deploy/cloudrun-deploy.sh` (Cloud Run + Cloud SQL in europe-north1).
5. Record the video using `docs/DEMO_SCRIPT.md`, and submit using `docs/SUBMISSION.md`.

## Known limitations
- The advisor reads types from the package's own `.d.ts`. Packages without types (like `debug`) fall back to semver: NO_CHANGE for minor and patch bumps, REVIEW for majors.
- The publisher handover signal needs the registry's per-version `_npmUser`, which some old versions lack.
- Watcher matching on blog text is deliberately strict, so it can miss a post that names a package only in its body without a version.
- The 665 MB container image could be slimmed down.
