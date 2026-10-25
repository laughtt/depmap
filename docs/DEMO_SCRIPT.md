# Demo video (under 3:00)

Record at 1280×720. Use AI narration and no third-party music. Have `pnpm db:up`, `node scripts/seed-demo.ts --reset`, the API, the mock GitLab and the UI running.

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:15 | Title card: "8 Sept 2025, 13:13 UTC: chalk and debug republished with malware. ~2B weekly downloads." | "Seventeen minutes later, no scanner on earth had a record. Here's a gate that would have stopped it anyway." |
| 0:15–0:35 | Connect screen: paste a token, or Continue with GitLab, pick `acme/shop`, Import. The **dig animation** fills the rings. | "First run: we crawl every dependency to the bottom of the tree. Rings are depth, wedges are what you installed." |
| 0:35–0:55 | Map: hover `ms`, and every path to the root lights up. Open the drawer and the Paths tab. | "Each package version gets a colour from behaviour, advisories and security watchers, and every colour links to its source." |
| 0:55–1:25 | MR !1 note in GitLab (chalk 4→5): Upgrade impact NEEDS_CHANGE, `src/log.js:1`, the fix, the alternatives. Then MR !2 shows NO_CHANGE. | "Upgrades: does *our* code need to change? The advisor reads both versions' type definitions and our call sites. chalk 5 is ESM-only; this exact line breaks." |
| 1:25–2:05 | Scrubber: replay MR !4 at **13:30**. Two reds from the cooldown rule, the gate blocked, and the flow's investigation note. Step to 18:00 (the OSV records arrive) and Sept 9 (Wiz's post, via watchers). Fingerprint: "looks like chalk/debug: 4 of 4". | "At 13:30 nothing knew. The cooldown held both. The agent explains it in plain language; the records and posts arrive hours later, and the map shows each one when it really existed." |
| 2:05–2:25 | A human note `/depmap accept … 1d: …`, the re-run goes green, the note updates in place, the decision expires. | "Humans decide, with a reason and an expiry. The agent never merges." |
| 2:25–2:45 | Watchers page plus refresh: one advisory re-colours `ms` in **both** repos, and issues open in each. Then the Pages security page and the SBOM. | "No commit needed: one advisory, every affected repo, an issue in each. Published as a security page and a CycloneDX SBOM." |
| 2:45–3:00 | Card: "9 stages · CI at 0 credits, LLM only for reds · 50k nodes in 7 ms (Rust→WASM) · SCI: warm scan 47 ms, 0 bytes". | "Built on GitLab Duo Agent Platform." |

Tip: show the true story too. Our own lockfile had a 7-hour-old hono, our tool flagged it, and pnpm's release-age policy independently refused it.
