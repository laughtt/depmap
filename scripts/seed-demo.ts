// Seeds the local demo timeline through the same scan pipeline CI uses.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { migrate, pool, q } from '../server/src/db/db.ts';
import { scan } from '../server/src/scanner/scan.ts';
import { refresh } from '../server/src/scanner/refresh.ts';
import { pollWatchers } from '../server/src/watchers/watchers.ts';

const DEMO = new URL('../demo/', import.meta.url).pathname;
const sha = (s: string) => createHash('sha1').update(s).digest('hex');

export function readProject(dir: string) {
  const sources: { path: string; content: string }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      if (f === 'node_modules' || f.startsWith('.')) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(m|c)?(j|t)sx?$/.test(f)) sources.push({ path: relative(dir, p), content: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return { lockfile: readFileSync(join(dir, 'package-lock.json'), 'utf8'), packageJson: readFileSync(join(dir, 'package.json'), 'utf8'), sources };
}

const steps = [
  { dir: 'shop', repo: 'acme/shop', ref: 'main', commit: 'c1', asOf: '2025-08-01T10:00:00Z' },
  { dir: 'scenarios/a-chalk5', repo: 'acme/shop', ref: 'chalk-5', commit: 'a1', base: 'c1', mrIid: 1, asOf: '2025-08-20T09:00:00Z' },
  { dir: 'scenarios/b-debug-patch', repo: 'acme/shop', ref: 'debug-4.3.7', commit: 'b1', base: 'c1', mrIid: 2, asOf: '2025-08-22T09:00:00Z' },
  { dir: 'scenarios/c-transitive', repo: 'acme/shop', ref: 'ms-override', commit: 'x1', base: 'c1', mrIid: 3, asOf: '2025-08-25T09:00:00Z' },
  { dir: 'scenarios/e-main-esm', repo: 'acme/shop', ref: 'main', commit: 'c2', asOf: '2025-09-01T10:00:00Z' },
  { dir: 'scenarios/d-replay-2025-09-08', repo: 'acme/shop', ref: 'deps-sept-8', commit: 'd1', base: 'c2', mrIid: 4, asOf: '2025-09-08T13:30:00Z' },
  { dir: 'scenarios/d-replay-2025-09-08', repo: 'acme/shop', ref: 'deps-sept-8', commit: 'd1', base: 'c2', mrIid: 4, asOf: '2025-09-08T18:00:00Z' },
  { dir: 'scenarios/d-replay-2025-09-08', repo: 'acme/shop', ref: 'deps-sept-8', commit: 'd1', base: 'c2', mrIid: 4, asOf: '2025-09-09T13:00:00Z' },
  { dir: 'admin', repo: 'acme/admin', ref: 'main', commit: 'm1', asOf: '2025-09-01T10:00:00Z' },
];

export async function seed() {
  await migrate();
  console.log('watchers:', (await pollWatchers({ fresh: true })).map((w) => `${w.id}:${w.items}`).join(' '));
  for (const s of steps) {
    const r = await scan({ ...readProject(join(DEMO, s.dir)), repo: s.repo, ref: s.ref, commitSha: sha(s.commit), baseSha: s.base ? sha(s.base) : undefined, mrIid: s.mrIid, asOf: s.asOf });
    console.log(`${s.repo} ${s.ref} @${s.asOf}: snapshot ${r.snapshotId}`, r.counts, r.gate.pass ? 'gate pass' : `gate FAIL ${r.gate.undecidedReds.join(', ')}`,
      r.advice.map((a) => `${a.package} ${a.from}→${a.to}: ${a.verdict}`).join(' | '));
  }
  if (process.env.ADVISORY_FEED) {
    const { flipped } = await refresh(process.env.REFRESH_AS_OF ?? '2026-10-25T12:00:00Z');
    console.log('refresh flipped:', flipped.map((f) => `${f.pv} ${f.from}→${f.to} in ${f.repos.join(', ')}`).join('; ') || 'nothing');
  }
}

if (import.meta.main) {
  if (process.argv.includes('--reset')) await q('drop schema public cascade; create schema public;');
  await seed();
  await pool.end();
}
