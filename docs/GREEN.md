# Sustainability: an SCI receipt for every scan

For the *Most Environmentally Impactful* prize. Every scan stores a carbon receipt in `snapshot.metrics`, and the Pages security page shows it per snapshot.

## Method (Software Carbon Intensity, ISO/IEC 21031:2024)
`SCI = (E × I + M) per R`, implemented in `server/src/scanner/sci.ts`.

- **R (functional unit):** one dependency scan of one lockfile. We also report gCO2e per 1,000 packages.
- **E (energy):** shared CI runners expose no RAPL power counters, so E is *calculated*, which the spec allows if disclosed. It uses Cloud Carbon Footprint's GCP coefficients:
  - compute: `(0.71 W + u × (4.26 − 0.71) W)` per vCPU, with `u` measured as CPU time ÷ wall time;
  - memory: 0.392 W per GB of RSS;
  - PUE 1.1;
  - network: 0.001 kWh per GB actually downloaded.
- **I (grid intensity):** location-based. The default is **579 gCO2e/kWh** for `us-east1`, where GitLab.com hosted runners run (Google Cloud 2025 region table). The Cloud Run script deploys to `europe-north1` at **30 gCO2e/kWh** and sets `SCI_GRID_INTENSITY=30`.
- **M (embodied):** not modelled, and reported as excluded rather than guessed.

## What the design saves, measured on this machine
| Run | Wall time | Network | gCO2e per scan |
|---|---|---|---|
| First scan of this app's own lockfile (140 packages, cold) | 11.4 s | 211 requests, 158 MB | 0.094 |
| Same scan, warm (facts cached per `package@version`) | 45 ms | 0 requests | ≈0.0000 |
| A 428-package Next.js app, cold | 29.3 s | 573 requests, 386 MB | 0.231 |
| Same app, warm | 47 ms | 0 requests | ≈0.0000 |

These savings come from three design choices:
1. **Immutable facts are cached forever.** A `package@version`'s publish time, scripts and maintainers never change, so they're fetched once.
2. **The graph is keyed by lockfile hash.** A push that doesn't touch the lockfile does no dependency work at all.
3. **Registry documents are trimmed before storage.** Full npm packuments can be tens of MB; we keep only the fields the rules read, which keeps fixtures and the cache small (1.4 MB for the whole demo).

The LLM is used only where judgment is needed: the flow investigates **red** packages only, and CI settles everything else deterministically at 0 credits.

## Moving the work to a cleaner grid
The same scan on Cloud Run in `europe-north1` (30 g/kWh) instead of a `us-east1` runner (579 g/kWh) cuts I by about 95% for identical work. That's why the deploy script picks that region.

## Reproduce
```
node scripts/scan-local.ts <project-dir>      # prints the receipt
SCI_GRID_INTENSITY=30 SCI_REGION=europe-north1 node scripts/scan-local.ts <project-dir>
```
