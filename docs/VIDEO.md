# Demo video script (target 2:45; AI narration; no third-party music or logos)

Record at 1440×900, dark theme, in the hackathon GitLab project and on https://lac.adtomic.co. About 380 words of narration (~140 wpm).

| Time | Screen | Narration |
|---|---|---|
| 0:00–0:15 | Black, then the headline "Sept 8, 2025 · 18 packages · 2.6B weekly downloads · ~2 hours" | On September 8th, 2025, an attacker phished an npm maintainer and republished eighteen packages, chalk and debug among them, with two and a half billion weekly downloads. The malware was live for about two hours. No scanner saw it, because no advisory existed yet. |
| 0:15–0:30 | depmap landing, then sign in, then Repositories, with the blast-radius card at the top | depmap is a GitLab-native supply-chain map. It follows every npm dependency of every project, colours it by risk, gates merge requests, and gets the fix done, with a human in charge. |
| 0:30–0:55 | GitLab MR "deps: Sept 8 bump" → pipeline: depmap:scan, depmap:gate (failed), depmap:report | Here is the bump from that morning, replayed hour by hour. The depmap jobs scan the lockfile. At 13:30 the gate already fails: these versions are only hours old, and the cooldown policy holds anything that fresh. By 18:00 the malware records arrive and the reason turns into proof. The attack is blocked before any advisory exists. |
| 0:55–1:20 | The MR comment: the map image, red packages, "Looks like chalk/debug takeover 4 of 4", "Used in src/log.js:1", the fix line | The report lands as one comment. It names the packages and matches the attack's fingerprint, four of four signals. It also shows exactly where our code uses chalk, src/log.js line 1, and the fix: pin 5.6.0. |
| 1:20–1:50 | Comment "@ai-depmap-gitlab-ai-hackathon fix chalk" → the Duo flow session log → the new MR with the package.json diff, lockfile commit and green pipeline | Now I ask the GitLab Duo agent to fix chalk. The flow reads the scan receipt from the job log, edits package.json, commits to a fix branch and opens a merge request. A CI job regenerates the lockfile, and depmap scans the fix. The pipeline is green. I review and merge. That's supervised autonomy: agents do the work, people approve. |
| 1:50–2:15 | adtomic MR !1 (pipeline: install → quality → depmap ✗ → build skipped) → comment "@… fix all" → MR !5 "Fix 17 packages" → its pipeline all green, report "✅ Ready to merge · 🔴 0" | It works on real apps too. This one had 17 red packages on its first scan, including a critical Clerk auth bypass and a Next.js RCE, so the build never ran. One comment, "fix all", and the agent upgraded four dependencies and pinned thirteen transitive ones in a single merge request. The pipeline reruns: zero red, the build goes through. For breaking upgrades, the fix list shows the exact code change, written by an AI that read the package's own migration guide. |
| 2:15–2:35 | The scheduled refresh pipeline → a security::watch issue in two repos; then a quick pan over the release page, `.depmap.yml` and the Decision tab | When the world changes without a commit, the hourly refresh re-checks every repo and opens an issue wherever the new advisory lands. Policy lives in .depmap.yml. Decisions expire and are audited. Every tag ships a release with its SBOM. That's all nine lifecycle stages. |
| 2:35–2:50 | The SCI footer in the MR comment: "0.0004 gCO₂e" | And it stays cheap enough to run on every push: a repeat scan costs about nine hundred times less carbon than a cold one. depmap: see the whole supply chain, and fix it before it ships. |

## Shot list to prepare
1. **The hackathon GitLab project,** with the MR "deps: Sept 8 bump" and its pipelines at 13:30 and 18:00. `scripts/local-gitlab.mjs` shows the same scenario steps for gitlab.com.
2. **A Duo flow session** for "@depmap fix chalk", and the resulting fix MR with a green pipeline.
3. **lac.adtomic.co,** signed in as judge: Repositories (blast radius), `local/adtomic` scan page, the zod card expanded.
4. **The scheduled refresh pipeline** and its `security::watch` issues.
5. **The release page** for tag `v1.0.0` with the SBOM asset.
