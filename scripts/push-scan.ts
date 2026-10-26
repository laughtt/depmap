// Scan a local project on the hosted depmap (sends its lockfile and JS/TS sources).
// usage: DEPMAP_TOKEN=<DEPMAP_CI_TOKEN> node scripts/push-scan.ts <dir> <repo> [--url https://lac.adtomic.co]
import { execSync } from 'node:child_process';
const { readLocalProject } = await import('./scan-local.ts');
const [dir, repo] = process.argv.slice(2);
const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'https://lac.adtomic.co';
const p = readLocalProject(dir);
const sha = (() => { try { return execSync('git rev-parse HEAD', { cwd: dir }).toString().trim(); } catch { return `local-${Date.now()}`; } })();
const ref = (() => { try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dir }).toString().trim(); } catch { return 'local'; } })();
const body = JSON.stringify({ repo, ref, commitSha: sha, lockfile: p.lockfile, packageJson: p.packageJson, sources: p.sources });
console.log(`${repo}: ${p.lockName}, ${p.sources.length} source files, ${(body.length / 1e6).toFixed(1)} MB, ${ref}@${sha.slice(0, 8)}`);
const res = await fetch(`${URL_}/api/scan`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.DEPMAP_TOKEN}` }, body });
const r: any = await res.json();
if (!res.ok) { console.log(res.status, r); process.exit(1); }
console.log(`snapshot ${r.snapshotId}: ${r.counts.total} packages · ${r.counts.red} red · ${r.counts.amber} amber · gate ${r.gate.pass ? 'pass' : 'FAIL'} · ${r.metrics?.wallMs} ms`);
for (const red of r.reds.slice(0, 6)) console.log(`  RED ${red.pv} · used in ${red.remedy?.usedIn.map((u: any) => `${u.file}:${u.line}`).slice(0, 2).join(', ') || '-'} via ${red.remedy?.usedBy} · fix: ${red.remedy?.action?.text ?? '-'}`);
console.log(`${URL_}/repos/${repo}/scans/${r.snapshotId}`);
