# depmap: catch the poisoned dependency before the advisory exists

**Scanners tell you a package was malicious, hours after you merged it. depmap blocks it while it is still minutes old, shows where it touches your code, and has a GitLab Duo flow open the fix.**

Built for the GitLab **Life After Code** hackathon · Path A · Supervised autonomy · all 9 DevSecOps stages · MIT

| | |
|---|---|
| **Live app** | https://lac.adtomic.co (judges: sign in as `judge`, password in the submission form) |
| **Code** | https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/5037040/depmap |
| **Demo video** | *(YouTube link)* |
| **Duo flow** | `flows/depmap.flow.yml` (4 agents) · mention the flow's service account, e.g. `@ai-depmap-gitlab-ai-hackathon fix chalk` |
| **Add it to any npm/pnpm project** | `include: - remote: https://lac.adtomic.co/ci/templates/depmap.gitlab-ci.yml` |

![The depmap map of a merge request: chalk@5.6.1 is red and matches 4 of 4 signals of the September 2025 account takeover](docs/img/map.png)

## The problem
On **8 September 2025** a phished npm maintainer republished **chalk, debug and 16 other packages**, together over 2 billion weekly downloads, with a crypto-stealer inside. The bad versions were live for about two hours.

At **13:30 UTC, seventeen minutes after publication, no scanner had a record.** OSV's malicious-package entries arrived at 14:26 and 17:11 UTC, and the detailed write-ups came the next day. Any team that merged a routine dependency bump in that window shipped the payload, and every CVE-based gate let it through. Weeks later the Shai-Hulud worm did it again.

OWASP's 2025 Top 10 put *Software Supply Chain Failures* at #3, and notes that only 11 CVEs map to it. Advisory scanners are blind by design in the hours that matter. Even when they do fire, they stop at "this is vulnerable" and leave the hard questions to you: *where does it reach my code, what do I change, and who decided to accept it?*

## The solution
depmap keeps **every dependency of every commit, down to the bottom of the tree, as state**, and judges each `package@version` by how it *behaves*, not only by what advisories say.

```
 push / MR ──CI──▶ depmap:scan ──▶ the depmap server
                     │   lockfile → full graph → registry facts → OSV + malware feeds
                     │   → 7 security watchers → behaviour rules → attack fingerprints
                     │   → upgrade advisor: which lines of YOUR code a bump breaks
                     ▼
               depmap:gate ── red and undecided? ──▶ pipeline fails
                     │                                   │
               depmap:report                     GitLab Duo flow (4 agents)
         one MR note, updated in place:          reader → triage → investigator
         map image · red packages + evidence                 └─▶ fixer: commit + fix MR
         · where your code uses them · the fix                    │
                     │                                    a human reviews and merges
          /depmap accept chalk@5.6.1 7d: reason   ◀── or decides, with an expiry
                     │
 scheduled ──▶ depmap:refresh: one new advisory re-colours the same version
               in EVERY repo and opens a security::watch issue in each
```

The Sept 8 replay, run hour by hour against what was public at each moment:

| As of (UTC) | What existed | depmap's gate |
|---|---|---|
| 13:30 | chalk@5.6.1 and debug@4.4.2, 17 minutes old; **no advisory anywhere** | **blocked**: cooldown rule plus the takeover shape |
| 18:00 | plus the OSV `MAL-` records | blocked, fingerprint "chalk/debug takeover" **4 of 4 signals** |
| 9 Sept, 13:00 | plus Wiz's write-up, found by the watchers | blocked, with the post linked |

The replay is honest: advisories are filtered by publish date, later unpublishing isn't visible to the past, and date-only feed timestamps count as end of day. Separately, when we containerised depmap, **pnpm's own release-age policy rejected the same two fresh packages our cooldown rule had flagged in our own lockfile.**

## How it works
1. **Scan every push and MR.** A two-line CI include sends the lockfile (npm or pnpm, including workspaces) and your JS/TS sources. Every `package@version` gets a colour:
   - **red:** a malicious-package record, a critical advisory, a version still inside the cooldown, a typosquat, an install script that appeared out of nowhere, or a publisher handover with provenance dropped;
   - **amber** or **green** otherwise.

   Red packages are matched against **fingerprints of real attacks**: chalk/debug 2025, Shai-Hulud 2025, ua-parser-js 2021, event-stream 2018. A fingerprint needs a real anomaly to fire.
2. **Show where it hurts.** The upgrade-impact advisor finds your import and call sites with `oxc`, then compares the old and new tarballs' `.d.ts` export surfaces (TypeScript compiler) and module formats. Each bump gets a verdict:
   - `NEEDS_CHANGE`, with `file:line`, for example `src/log.js:1`: *chalk 5 is ESM-only, so `require('chalk')` throws `ERR_REQUIRE_ESM`*;
   - `REVIEW`;
   - `NO_CHANGE`;
   - `PATH_ONLY`: *no code change; it reaches you via shop → debug → ms*.
3. **Gate the merge.** `depmap:gate` fails while a red package is undecided. `depmap:report` posts **one MR note, edited in place**, with:
   - a rendered map image;
   - the red packages with linked evidence;
   - the upgrade impact;
   - the exact fix (a `package.json` line or an `overrides` entry).

   It also sets a `depmap` commit status that opens the push's own page.
4. **The Duo flow investigates and fixes.** When the pipeline fails, the flow reads the scan receipt from the job log and explains each red package in plain language. A developer comments `@<flow account> fix chalk`, and the fixer:
   - edits `package.json` and any required code lines;
   - commits to `depmap/fix-chalk-…`;
   - opens a fix MR.

   `depmap:relock` regenerates the lockfile there (`--lockfile-only`, no scripts), and the new pipeline scans it again. **A human reviews and merges.**
5. **Decide, on the record.** `/depmap accept chalk@5.6.1 7d: reason`, or `pin`, or the Decision tab, records who decided, why, and until when. When the expiry passes, the gate blocks again.
6. **Watch the world, not just the commits.** A scheduled pipeline polls 7 security watchers (GitHub malware advisories, Aikido, StepSecurity, Wiz, Snyk, OpenSSF, CISA) and re-assesses every branch head. Risk belongs to the `package@version`, so **one advisory flips it in every repo at once** and opens an issue in each.

![The MR thread: depmap's CI note with the map, changed packages, red packages and upgrade impact, followed by the Duo flow's investigation](docs/img/mr-thread.png)
*The MR thread from our end-to-end run against the local GitLab stand-in: the CI note (0 credits), then the Duo flow's investigation.*

## The Duo Agent Platform flow
One flow (`flows/depmap.flow.yml`, flow registry v1, `environment: ambient`) with four agent components. CI does every deterministic step for 0 credits; **the LLM only runs for red packages.**

| Agent | Tools | What it does |
|---|---|---|
| **reader** | `get_merge_request`, `gitlab_api_get`, `get_job_logs` | finds the MR's `depmap:scan` job and reads the receipt; returns `SKIP` when there's nothing to do |
| **triage** | `get_merge_request` | routes the request: explain, or fix |
| **investigator** | `create_merge_request_note` | one plain-language note per red package: what happened, what the fingerprint means, the safest action |
| **fixer** | `get_repository_file`, `create_commit`, `create_merge_request`, `create_merge_request_note` | edits `package.json` and code, commits to `depmap/fix-*`, opens the fix MR and links it back |

| Trigger | Fires when |
|---|---|
| **Pipeline events: Failed** | `depmap:gate` blocks a merge request |
| **Mention** | someone writes `@<flow account> explain` or `@<flow account> fix <pkg>` in the MR |
| **REST fallback** | `depmap:report` starts the flow through `POST /api/v4/ai/duo_workflows/workflows` when triggers aren't available |

The flow never runs package code and never crawls the registry; CI already did that. Flow runs stay short and cheap. `flows/simulate.ts` validates the YAML and walks the flow against a mock GitLab in the tests.

**Where Claude works:**
- The four flow agents run on the Duo Agent Platform's models.
- When a fix crosses a breaking version, a background fixer uses **Claude Haiku 5.5** (`server/src/advisor/aifix.ts`, structured output plus web fetch). It reads the package's own migration notes and writes exact line edits, and we verify that each edit matches the file before showing it.
- The fixer runs only where code can break: 2 of 17 red packages on our test app.

## Every push gets a page
![The per-push page: the dependency tree with chains to red packages in red, and a "To merge" list with each package's evidence, fingerprint and fix](docs/img/push-page.png)

The `depmap` commit status links to `/repos/<group>/<project>/scans/<scan>`:
- **left:** the tree upside down, your repo on top, with every chain to a red package drawn in red;
- **right:** what to do to merge. For each package: the fix version or the version to stay on, the `/depmap accept` command, and every `file:line` your code must change.

## All dependencies: one map of everything we've seen
![The All dependencies page: 10,621 packages and 33,310 links, sized by how many packages depend on each one](docs/img/world.png)

- **One map across every repo:** one node per package, all versions folded together, sized by how many packages depend on it.
- **Click a package** for its full version history: publish date, publisher, provenance, the advisories, and for each advisory:
  - the affected range;
  - the CWE;
  - **the fixed version** (or the newest clean one when no fix exists);
  - the fix commit;
  - the advisory's own vulnerable code and PoC.
- **Every package is classified three ways:**
  - **what it does:** 14 categories;
  - **how it's used:** runtime or dev-only, direct, install script;
  - **how far to trust it:** one maintainer, **load-bearing** (10 or more dependents and a single maintainer), no provenance, stale, deprecated.
- **Filters** dim everything that doesn't match. *Runtime http packages with one maintainer and no provenance* is one click.
- **Kept fresh by a crawler** (`scripts/crawl.ts`) that follows each package to its own repo's lockfile. The hosted instance holds about **10.9k packages and 29k versions**.

## Prize tracks
| Track | Why depmap qualifies |
|---|---|
| **Path A: Supervised** | Agents investigate and open fix MRs on their own; a human merges or accepts the risk, with an expiry and an audit trail |
| **Most Stages Covered** | All nine, each with an artifact you can open, in `docs/STAGES.md`: plan (`security::watch` issues) · create (fix MRs) · verify (the gate) · package (CycloneDX SBOM, image) · secure (rules, feeds, fingerprints) · release (tag pipeline, GitLab Release) · configure (`.depmap.yml`, CODEOWNERS) · monitor (scheduled refresh, watchers, commit status) · govern (decisions with expiry, audit events) |
| **Most Environmentally Impactful** | An SCI receipt on every scan (below and `docs/SUSTAINABILITY.md`) |
| **Most Creative** | Behaviour fingerprints of real attacks, an honest hour-by-hour replay of a real incident, and one map of every dependency we have ever seen |
| **Google Cloud bonus** | `deploy/cloudrun-deploy.sh` deploys to Cloud Run with Cloud SQL in `europe-north1`, chosen for its grid intensity. The current live instance runs on EC2. |

## Sustainability (SCI)
Every scan records its Software Carbon Intensity:
- **E:** Cloud Carbon Footprint coefficients applied to measured CPU, memory and bytes;
- **I:** location-based;
- **M:** excluded, and we say so.

| Run | Wall time | Network | gCO₂e |
|---|---|---|---|
| A 428-package Next.js app, cold | 29.3 s | 573 requests, 386 MB | 0.231 |
| Same app, warm | **47 ms** | **0 requests** | ≈0.0000 |

- **Why warm is free:** registry facts are immutable per `package@version`, so they're cached once and shared by every repo. Graphs are keyed by lockfile hash. "The world changed" is a re-assessment, not a re-crawl.
- **Region:** `europe-north1` (30 g/kWh) instead of a `us-east1` runner (579 g/kWh) cuts I by about 95% for identical work.
- **The LLM runs only for red packages.** Everything else is deterministic CI.

## Tech stack
| Layer | What |
|---|---|
| Graph core | **Rust → WebAssembly**: binary graph codec, stable layout, paths to root, diff. **50k nodes laid out in about 7 ms**, cached in IndexedDB |
| Map | Vite + TypeScript, sigma.js / graphology (WebGL), ForceAtlas2 for the All dependencies map |
| Server | Node 26 (TypeScript type stripping), Hono, PostgreSQL 17 |
| Analysis | oxc-parser (call sites), the TypeScript compiler API (`.d.ts` diff), semver |
| Data | npm registry, OSV.dev, GitHub malware advisories, 7 security watchers, e18e `module-replacements` |
| GitLab | Duo Agent Platform flow, CI/CD template, MR notes, labels, commit statuses, issues, schedules, CycloneDX reports, Releases, Container Registry, OAuth |
| AI | GitLab Duo flow agents; Claude Haiku 5.5 for code fixes across breaking versions |

## Project structure
```
crates/graph-core/        Rust/WASM graph core (docs/CONTRACT.md)
server/src/scanner/       lockfiles, registry facts, OSV, rules, fingerprints, scan, refresh, SCI meter, classify
server/src/advisor/       upgrade-impact advisor, Claude fixer
server/src/watchers/      the 7 security watchers
server/src/connector/     GitLab connector: PAT or OAuth with PKCE, tokens AES-256-GCM encrypted
server/src/gitlab/        local GitLab stand-in (REST v4 shapes, OAuth, uploads, MR viewer, flow start)
web/                      the map UI
ci/, ci/templates/        CI scripts and the includeable template
flows/                    the Duo flow (v1 YAML) and its simulator
.gitlab/duo/              agent-config.yml for the flow runtime
scripts/                  demo, seed, scan-local, crawl, local GitLab, Pages export, test-all
deploy/                   Dockerfile, compose.prod.yml + ec2-deploy.sh, cloudrun-deploy.sh
docs/                     STAGES, GITLAB, SUSTAINABILITY, GREEN, CONTRACT, DEVPOST, DEMO_SCRIPT
```

## Try it
**Option A: see it running.** Open https://lac.adtomic.co and sign in as `judge`. The repos, the per-push pages, the Watchers page and the All dependencies map are all there.

**Option B: run it locally, offline.**
```
scripts/demo.sh        # Postgres + the seeded Sept 8 timeline + API/UI on :8787 + local GitLab on :8929/view
```
Or step by step:
```
pnpm install
pnpm db:up                                   # Postgres 17 in Docker on :5433 (named volume db-data)
pnpm build:wasm && pnpm build:web
DATA_MODE=replay ADVISORY_FEED=fixtures/feed/simulated-advisory.json node scripts/seed-demo.ts --reset
DATA_MODE=replay node server/src/api/main.ts # API + UI on http://localhost:8787
node server/src/gitlab/mock.ts               # local GitLab on http://localhost:8929 (/view shows the MRs)
```
- **`DATA_MODE`:** `replay` uses recorded public data in `fixtures/` (offline and deterministic), `record` fetches what's missing, and `live` always fetches.
- **Scan any project on disk** (read-only): `node scripts/scan-local.ts ../my-app`.
- **Grow the All dependencies map:** `node scripts/crawl.ts`. Ctrl-C stops it, and it resumes from its queue.
- **Export the GitLab Pages security site:** `node scripts/export-pages.ts public`.

**Option C: add it to your project.**
```yaml
include:
  - remote: https://lac.adtomic.co/ci/templates/depmap.gitlab-ci.yml
```
Set `DEPMAP_API_URL`, plus the masked `DEPMAP_TOKEN` and `GITLAB_TOKEN`. Then create the flow in AI › Flows from `flows/depmap.flow.yml` and add the triggers. `docs/GITLAB.md` has every step.

## Policy as code: `.depmap.yml`
```yaml
cooldown_hours: 48          # red while younger than this, amber "recent" up to 3x (default 24)
block_on: [red, amber]      # colours that fail depmap:gate (default [red])
allow:                      # standing accept decisions: name@semver-range plus why
  - pkg: debug@~4.4.0
    reason: pinned by the logging team
licenses:
  deny: [AGPL-3.0]          # the package turns red; also matches -only / -or-later
```
- `depmap:scan` sends the file with every scan. The rules, the gate, the UI and the scheduled refresh all judge with the same policy.
- A typo or unknown key fails the scan.
- The gate log names the rule for each blocked package, e.g. `x chalk@5.6.1  [policy: block_on: red · cooldown_hours: 48]`.
- `CODEOWNERS` protects `.depmap.yml` and `ci/`.

## Proof it works
`pnpm test:all` runs everything and writes `test-results/summary.json`:
- **42 server tests** (vitest, on a separate `depmap_test` database), **11 Rust tests** and **16 Playwright browser tests** (mock and live API);
- **the GitLab end-to-end MR scenarios** under gitlab-ci-local: 22/22 checks;
- **the complete pipeline on a real GitLab** (`pnpm test:gitlab-real`): GitLab CE 19.5 and a runner in Docker. It pushes the demo repos, which include the template remotely, then runs main, three MRs (chalk 5, a debug patch, the Sept 8 replay), a human `/depmap accept`, a re-run and a scheduled refresh. It checks the notes, labels, uploads, commit statuses and issues.

**Releases:** pushing a `v*` tag runs the tests, pushes the image to the Container Registry, gates depmap's own lockfile with depmap, and creates a GitLab Release with a changelog and the CycloneDX SBOM attached.

## Hosting
- **https://lac.adtomic.co:** one EC2 host. Caddy terminates TLS in front of the depmap container and Postgres (`deploy/compose.prod.yml`); redeploy with `deploy/ec2-deploy.sh`.
- **Sign-in:** with `REQUIRE_LOGIN=1`, every API route needs either a depmap account (scrypt-hashed) or GitLab OAuth with PKCE (scope `read_api`), which also connects your projects. CI jobs authenticate with the masked `DEPMAP_TOKEN`.
- **Private scans stay put:** scans of private repos (`fixtures/local`) never leave the machine; `.dockerignore` keeps them out of the image.
- **Cloud Run:** see `deploy/cloudrun-deploy.sh` and `docs/GITLAB.md`.

## License
MIT. See `LICENSE`.
