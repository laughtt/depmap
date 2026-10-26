# Sustainability: what one dependency scan costs, measured with SCI

DepthMap measures every scan with the Green Software Foundation's **Software Carbon Intensity** (SCI, ISO/IEC 21031:2024), and stores it with the snapshot (`snapshot.metrics`). The functional unit **R is one dependency scan**.

```
SCI = (E × I + M) per R
E  energy: measured CPU time and wall time, memory (RSS) and bytes moved, converted with Cloud Carbon Footprint coefficients
   (0.71–4.26 W per vCPU, 0.392 W per GB of memory, PUE 1.1, 0.001 kWh per GB of network)
I  grid intensity: 579 gCO₂e/kWh (us-east1, where GitLab.com hosted runners run; Google 2025 table)
M  embodied emissions: not modelled, reported as excluded
```

The code is in `server/src/scanner/sci.ts`. Every MR comment ends with a "receipt" line showing the scan's SCI.

## Measured on a real app (adtomic, 640 npm packages, live server)

| Scan | Wall time | Registry/API fetches | Bytes downloaded | SCI per scan |
|---|---|---|---|---|
| First scan (cold) | 32.3 s | 722 | 619 MB | **0.371 gCO₂e** |
| Next push, same lockfile | 0.52 s | 0 | 0 MB | **0.0004 gCO₂e** |

A repeat scan costs about **900× less** than a cold one. These are the snapshots 13, 14 and 15 on https://lac.adtomic.co.

## Why it is cheap: three design choices
1. **A package version is immutable, so its facts are fetched once.**
   - What we cache, keyed by `package@version`: registry facts, OSV advisories, tarball type surfaces and changelogs.
   - The result: a push only fetches what is new in that lockfile, and every repo in the organization shares those facts.
2. **The graph is reused by lockfile hash.** An unchanged lockfile reuses the stored graph and layout (Postgres, and IndexedDB in the browser), so nothing is parsed or laid out again.
3. **"The world changed" is a re-assessment, not a re-crawl.** The hourly refresh re-checks the stored graphs of every repo against today's advisories: no registry crawl and no `npm install`. One advisory re-colours every repo that contains the package.

## AI only where code can break
- **Who gets an AI pass:** only packages whose fix crosses a breaking version, or replaces the package, *and* that the repo's own code imports.
- **What everything else gets:** a deterministic fix (the `package.json` line).
- **On adtomic:** 2 of 17 red packages got an AI pass. That avoids about 88% of the model calls a "send every finding to the LLM" design would make.
- **The model:** Claude Haiku 5.5, the smallest current model. Fixes are cached by package, target version and code, so the same fix is never generated twice.
- **What is not counted:** the model's own energy, because no per-token energy figure is published. We report token counts per fix instead, about 40–50k input tokens.

## Projection for one team
**Assumptions (estimates, not measurements):**
- 50 repositories, 20 pipelines per repo per day;
- 10% of pipelines change the lockfile;
- the cold-scan figure is used even when only a few packages are new, which is pessimistic.

| Approach | gCO₂e per day |
|---|---|
| Crawl everything on every pipeline | 1,000 × 0.371 ≈ **371 g** |
| DepthMap (crawl only new lockfiles, reuse the rest) | 100 × 0.371 + 900 × 0.0004 ≈ **37.5 g** |

That is about **90% less**, before counting that facts are shared across repos.

The point is not the grams. **Supply-chain checks stay cheap enough to run on every push**, which is when they matter.
