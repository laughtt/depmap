# Devpost submission draft

> "depmap" is a working name. The organizers advise choosing a name that says what the project does, so pick the final name yourselves.

**Path A (new project) · Supervised autonomy** (agents investigate and advise; humans accept risk, with an expiry) · **All 9 DevSecOps stages** · Built for GitLab Duo Agent Platform

## Inspiration
On **8 September 2025** a phished npm maintainer account republished chalk, debug and 16 other packages, about 2 billion weekly downloads, with a crypto-stealing payload. The malicious versions were live for roughly two hours.

At 13:30 UTC, seventeen minutes after they were published, **no scanner had a record**. OSV's malicious-package entries arrived at 14:26 and 17:11 UTC, and the first deep write-ups the next day.

OWASP's 2025 Top 10 added *Software Supply Chain Failures* at #3 and notes that only 11 CVEs map to it, because CVE scanners structurally miss this class of attack.

## What it does
A map of every dependency down to the bottom of the tree, kept as **state per commit**, plus agents that watch it change.

- **First run per repo:** connect GitLab (a personal access token or OAuth with PKCE; the token is encrypted on the server). The tool crawls the whole lockfile tree (npm or pnpm) and colours every `package@version` red, amber or green. The colours come from:
  - behaviour signals: a release younger than the cooldown, the takeover shape (new publisher, provenance dropped, a new install script), deprecated, typosquat;
  - OSV and GitHub malware advisories;
  - **security watchers**, which read where incidents get posted first: Aikido, StepSecurity, Wiz, Snyk, OpenSSF, CISA.
- **Every merge request:** CI diffs the dependency graph. The **upgrade-impact advisor** tells you whether *your* code must change and where. For example, chalk 4 → 5 gives "`src/log.js:1`: chalk 5 is ESM-only; `require('chalk')` throws `ERR_REQUIRE_ESM` on Node 18 and returns a namespace on Node ≥ 20.19, so `chalk.red` is undefined", with the fix and alternatives. It reads the old and new tarballs' `.d.ts` with the TypeScript compiler and finds call sites with an AST parser. Transitive bumps are reported as "no code change; reaches you via a → b".
- **Red packages fail the gate.** A Duo flow investigates them and posts a plain-language explanation, including which real attack the package resembles ("looks like the chalk/debug takeover: 4 of 4 signals"). A human clears the gate with `/depmap accept pkg@ver 7d: reason`. The decision is recorded with an expiry, and an expired decision re-blocks the gate.
- **The world changes without a commit.** A scheduled pipeline re-checks every branch head. Risk belongs to the `package@version`, so **one new advisory re-colours every repo that contains it** and opens an issue in each.
- **The map:** a Rust → WebAssembly graph core lays out and queries tens of thousands of nodes in milliseconds (50k nodes in 7.6 ms), cached in IndexedDB. Rings are depth, wedges are direct dependencies, positions stay stable across commits, and a time scrubber replays history.

## The Sept 8 2025 replay (in the demo)
| As of (UTC) | What the gate knew | Result |
|---|---|---|
| 13:30 | chalk@5.6.1 and debug@4.4.2 were 17 minutes old; no advisory existed | **blocked** by the cooldown rule |
| 18:00 | plus the OSV `MAL-` records | blocked, fingerprint 4/4 |
| Sept 9, 13:00 | plus Wiz's breakdown, via the watchers | blocked, with the post linked |

The replay is honest. Advisories are filtered by publish date, a version being unpublished later is not visible to a past replay, and date-only feed timestamps count as end of day. Separately, when we containerised the tool, **pnpm's own release-age policy rejected the same two fresh packages our cooldown rule had flagged in our own lockfile.**

## How we used GitLab
- **Duo Agent Platform custom flow** (`flows/depmap.flow.yml`, v1). A *reader* reads the CI receipt through `get_job_logs`, and an *investigator* explains reds and posts with `create_merge_request_note`.
- **Triggers:** pipeline events (failed or passed) and mention, with the REST flow-start endpoint as the fallback.
- **CI does every deterministic step at 0 credits:** scan, gate, the map image, the MR note, the SBOM, a scheduled refresh and the Pages export. The LLM runs only for red packages.
- **GitLab features used:**
  - MR notes and labels, which the report updates in place rather than duplicating;
  - human `/depmap` notes as auditable approvals;
  - issues for newly red packages;
  - **CycloneDX** report artifacts for the dependency list;
  - **GitLab Pages** for a per-repo security page;
  - scheduled pipelines;
  - an OAuth application for the connector.
- See `docs/STAGES.md` for the nine stages.

## Sustainability (SCI)
Every scan carries an SCI receipt. E comes from Cloud Carbon Footprint coefficients on measured CPU, memory and bytes; I is location-based; M is excluded and disclosed.
- Immutable facts are cached per `package@version` and graphs are keyed by lockfile hash. A warm re-scan of a 428-package app takes **47 ms with zero network**, against 29 s and 386 MB cold.
- Deploying to `europe-north1` (30 g/kWh) instead of a `us-east1` runner (579 g/kWh) cuts I by about 95%.
- Details are in `docs/GREEN.md`.

## Challenges
- **Honest replays:** registries show today's state, and feeds have date-only timestamps. Every signal had to be time-bounded.
- **Calibration without noise:**
  - Maintainers of big packages take turns publishing, so a "new publisher" only counts when it's someone outside the previous maintainer list, within 90 days, and not trusted publishing.
  - Dev-only build tools with DoS bugs are amber, while malware in dev dependencies stays red, because that's how Shai-Hulud stole CI secrets.

## Built with
GitLab Duo Agent Platform, GitLab CI/CD, GitLab Pages, Rust + wasm-bindgen, TypeScript (Node 26 type stripping), Hono, PostgreSQL, sigma.js / graphology (WebGL), oxc-parser, the TypeScript compiler API, OSV.dev, the npm registry, the GitHub Advisory API, CycloneDX and Playwright.
