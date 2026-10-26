// Scan a local project directory (read-only) into the local depmap database.
// usage: node scripts/scan-local.ts <dir> [--repo name] [--ref main] [--as-of ISO]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

process.env.DATA_MODE ??= 'record';
process.env.FIXTURES_DIR ??= new URL('../fixtures/local/', import.meta.url).pathname;
const { migrate, pool } = await import('../server/src/db/db.ts');
const { scan } = await import('../server/src/scanner/scan.ts');

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.git', '.turbo', 'out', 'vendor']);

export function readLocalProject(dir: string) {
  const lockName = ['package-lock.json', 'pnpm-lock.yaml'].find((f) => existsSync(join(dir, f)));
  if (!lockName) throw new Error(`no package-lock.json or pnpm-lock.yaml in ${dir}`);
  const sources: { path: string; content: string }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (SKIP.has(f) || f.startsWith('.') || sources.length >= 400) continue;
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(m|c)?(j|t)sx?$/.test(f) && st.size < 300_000) sources.push({ path: relative(dir, p), content: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return { lockName, lockfile: readFileSync(join(dir, lockName), 'utf8'), packageJson: existsSync(join(dir, 'package.json')) ? readFileSync(join(dir, 'package.json'), 'utf8') : undefined, sources };
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { repo: { type: 'string' }, ref: { type: 'string' }, 'as-of': { type: 'string' } } });
  const dir = resolve(positionals[0] ?? '.');
  const repo = values.repo ?? `local/${basename(dir)}`;
  await migrate();
  const p = readLocalProject(dir);
  const r = await scan({ repo, ref: values.ref ?? 'local', commitSha: `local-${Date.now()}`, lockfile: p.lockfile, packageJson: p.packageJson, sources: p.sources, asOf: values['as-of'] });
  console.log(`${repo} (${p.lockName}, ${p.sources.length} source files): snapshot ${r.snapshotId}`);
  console.log(`  ${r.counts.total} packages · ${r.counts.red} red · ${r.counts.amber} amber · ${r.counts.green} green · ${r.counts.grey} grey · gate ${r.gate.pass ? 'pass' : 'FAIL'}`);
  const m = r.metrics;
  console.log(`  ${m.wallMs} ms, ${m.fetches} fetches (${m.cacheHits} cache hits), ${(m.bytes / 1e6).toFixed(1)} MB · SCI ${m.gco2e.toFixed(4)} gCO2e per scan (${m.region}, ${m.intensity} g/kWh)`);
  const { q } = await import('../server/src/db/db.ts');
  for (const row of await q('select pv, color, reasons, fingerprint from snapshot_pv where snapshot_id = $1 and color in (1, 2) order by color desc, pv limit 15', [r.snapshotId])) {
    console.log(`  ${row.color === 2 ? 'RED  ' : 'amber'} ${row.pv}: ${row.reasons.map((x: any) => x.text).join(' | ').slice(0, 220)}${row.fingerprint ? ` [looks like ${row.fingerprint.title}]` : ''}`);
  }
  console.log(`  map: http://localhost:8787/repos/${repo}/map/${r.snapshotId}`);
  await pool.end();
}
