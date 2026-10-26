# depmap: a live supply-chain map that gates and fixes risky npm dependencies in GitLab

**Path A (new project) · Supervised · all 9 lifecycle stages · sustainability opt-in**

- Live: https://lac.adtomic.co (judges: sign in as `judge`, password in the submission form)
- Code: https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/5037040/depmap
- Video: <YouTube URL>

## The problem
On **September 8, 2025** a phished maintainer republished **18 npm packages with about 2.6 billion weekly downloads** (chalk, debug and others) with a crypto-stealer inside. The bad versions lived for about two hours. Any team that merged a routine dependency bump in that window shipped malware.

Weeks later the Shai-Hulud worm did it again. Scanners that only read advisory databases are blind in those first hours, because no advisory exists yet. They also stop at "this is vulnerable" and leave the hard part to developers: where is it used in my code, what do I change, and will the upgrade break me?

## What DepthMap does
DepthMap runs inside GitLab and makes every npm dependency of a project visible, colours each one by risk, blocks risky ones in merge requests, and gets them fixed. A human approves the fix.

1. **Scan on every push and merge request.**
   - A two-line CI include (`depmap:scan`) sends the lockfile and the JS/TS sources.
   - DepthMap resolves the full tree and colours each `package@version`:
     - **red:** a malicious-package record, a critical advisory, a version that is too fresh during a cooldown, a typosquat, an install script that appeared out of nowhere;
     - **amber** or **green** otherwise.
   - It also matches **fingerprints of past attacks** (event-stream, ua-parser-js, colors and faker, chalk and debug 2025, Shai-Hulud). For example: "looks like the chalk/debug takeover: 4 of 4 signals".
2. **Gate the merge request.**
   - `depmap:gate` fails while a red package is undecided.
   - `depmap:report` posts one MR comment, updated in place, with:
     - a rendered map of what changed;
     - the red packages with linked evidence;
     - **where your code uses each one** (`src/log.js:1`);
     - the **fix** (exact `package.json` line, or an `overrides` entry);
     - an **AI-written code change** when the fix crosses a breaking version.
   - It also sets a `depmap` commit status that links to the push's own page.
3. **The GitLab Duo flow investigates and fixes.**
   - When the pipeline fails, the **Duo Agent Platform flow** reads the scan receipt from the job log and explains the risk in plain language.
   - A developer comments **`@ai-depmap-gitlab-ai-hackathon fix chalk`** (the flow's service account; GitLab creates one per project). The flow's fixer agent:
     1. edits `package.json` (and the required code lines);
     2. commits to `depmap/fix-chalk-5.6.0`;
     3. opens a fix merge request and links it back.
   - `depmap:relock` regenerates the lockfile in that MR's pipeline, which scans again. **A human reviews and merges: supervised autonomy.**
   - **On a real app's first scan:** adtomic (640 packages) had 17 red packages, so its build was blocked.
     - One comment, `@… fix all`, made the agent open a single MR (4 direct upgrades, 13 overrides).
     - `depmap:relock` regenerated the lockfile, and the rescan showed **0 red**. The full pipeline, including build, went green.
4. **Decide, with an audit trail.** `/depmap accept chalk@5.6.1 7d: reason` (or the Decision tab: fix with an MR, accept, or pin) records who decided, why, and until when. The gate respects it until it expires.
5. **Watch the world change.**
   - A scheduled `depmap:refresh` re-assesses every repo against today's advisories and the security blogs (GitHub malware advisories, Aikido, StepSecurity, Wiz, Snyk, OpenSSF, CISA).
   - When one advisory lands, it flips the same package version in **every** repo and opens a `security::watch` issue in each one.

The web app (live map, per-push page, fix cards with links to the exact file and line on GitLab) is where people explore. GitLab is where the work happens.

## How GitLab automates the post-code lifecycle (all 9 stages)
| Stage | In DepthMap |
|---|---|
| plan | `security::watch` issues opened by the scheduled refresh when a new advisory hits a repo |
| create | fix merge requests opened by the Duo fixer agent, or from the Decision tab |
| verify | the `depmap:gate` job blocks MRs with undecided red packages; fix MRs are rescanned |
| package | CycloneDX SBOM per pipeline, with risk as component properties |
| secure | risk rules, OSV / malicious-package records, attack fingerprints, cooldown |
| release | the tag pipeline builds the image, publishes the SBOM and creates a GitLab Release |
| configure | `.depmap.yml` policy as code (cooldown, what blocks, allow list, denied licenses), protected by CODEOWNERS |
| monitor | the hourly refresh, security-blog watchers, a commit status per pipeline |
| govern | `/depmap accept|pin` decisions with expiry and an audit log; Decision tab; fix decisions linked to MRs |

## How it uses the GitLab Duo Agent Platform
- **One flow (flow registry v1) with 4 agent components:**
  - **reader:** finds the MR's `depmap:scan` job and reads the receipt with `get_job_logs`;
  - **triage:** explain or fix;
  - **investigator:** explains risk in a single MR note;
  - **fixer:** `get_repository_file` → `create_commit` → `create_merge_request` → `create_merge_request_note`.
- **Triggers:** pipeline failed, `@depmap` mention, and a REST start from CI as a fallback.
- **The flow never runs package code or crawls the registry.** CI already did, so flow runs stay short and cheap.

## How we built it
- **Rust → WebAssembly graph core:** layout, paths and diff; 50k nodes laid out in milliseconds, with the layout cached by lockfile hash.
- **Server:** Node/TypeScript (Hono) with Postgres. Data sources: npm registry, deps.dev, OSV, package tarballs read without executing anything, and `oxc` to find import and call sites.
- **Upgrade advisor:** compares the `.d.ts` export surfaces and module formats of two versions to tell whether a bump breaks your code.
- **Background fixer:** Claude Haiku 5.5 with structured output and web fetch. It reads the package's own migration notes, writes exact line edits, and we verify that each edit matches the file before showing it.
- **Replacements** from the e18e `module-replacements` dataset (built-in APIs or lighter packages).
- **Tests:**
  - 37 server tests, 14 browser tests, 11 Rust tests;
  - an end-to-end run of all the CI jobs against a mock GitLab;
  - a full scenario on a real GitLab CE with a runner.

## Sustainability (SCI)
Every scan records its Software Carbon Intensity:
- a cold scan of a 640-package app: **0.371 gCO₂e**;
- the next push with the same lockfile: **0.0004 gCO₂e** (about 900× less), because package facts are immutable and shared, graphs are reused by lockfile hash, and "the world changed" is a re-assessment, not a re-crawl;
- the AI only runs where code can break (2 of 17 reds on our test app).

Details: `docs/SUSTAINABILITY.md`.

## Challenges
- Telling the truth about time: replaying Sept 8, 2025 hour by hour (13:30 cooldown, 18:00 OSV records, the next day's blog posts) without ever fetching a malicious tarball.
- Making the AI's edits trustworthy: exact-match verification and a "required vs optional" split, and it reads the real migration guide instead of guessing.
- A flow can't run `npm install`, so the lockfile is regenerated by a CI job with `--ignore-scripts`.

## What's next
- GitLab "Apply suggestion" comments on the exact MR lines.
- pnpm workspaces and monorepos.
- An org-wide blast-radius view as the security team's home page.
