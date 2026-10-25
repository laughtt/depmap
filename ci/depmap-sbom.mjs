// depmap:scan (sbom): fetch the snapshot's CycloneDX SBOM for GitLab's dependency list. Skips when the API has none.
import { writeFileSync } from 'node:fs';
import { API, readResult } from './depmap-lib.mjs';

const { snapshotId } = readResult();
const res = await fetch(`${API}/api/snapshots/${snapshotId}/sbom.cdx.json`);
if (!res.ok || !res.headers.get('content-type')?.includes('json')) {
  console.log(`depmap sbom: skipped (${res.status})`);
  process.exit(0);
}
writeFileSync('gl-sbom-npm-depmap.cdx.json', await res.text());
console.log('depmap sbom: wrote gl-sbom-npm-depmap.cdx.json');
