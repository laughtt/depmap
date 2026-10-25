// Runs every suite and writes test-results/summary.json. Needs Postgres (pnpm db:up).
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const suites = [
  ['rust', 'cargo', ['test', '--quiet'], { cwd: `${root}crates/graph-core` }],
  ['server', 'pnpm', ['--filter', 'server', 'test']],
  ['web (mock data)', 'pnpm', ['--filter', 'web', 'test:e2e']],
  ['web (live API)', 'pnpm', ['--filter', 'web', 'test:e2e'], { env: { DEPMAP_MODE: 'live' } }],
  ['gitlab e2e', 'node', ['scripts/e2e-gitlab.mjs']],
];

const results = [];
for (const [name, cmd, args, opts = {}] of suites) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, encoding: 'utf8', maxBuffer: 64 << 20 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  results.push({ name, ok: r.status === 0, seconds: Math.round((Date.now() - t0) / 100) / 10, tail: out.trim().split('\n').slice(-12).join('\n') });
  console.log(`${r.status === 0 ? 'PASS' : 'FAIL'}  ${name}  (${results.at(-1).seconds}s)`);
  if (r.status !== 0) console.log(results.at(-1).tail);
}
mkdirSync(`${root}test-results`, { recursive: true });
writeFileSync(`${root}test-results/summary.json`, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
