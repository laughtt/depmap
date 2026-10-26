import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, pool, q } from '../src/db/db.ts';
import { seed } from '../../scripts/seed-demo.ts';
import { scan } from '../src/scanner/scan.ts';
import { refresh } from '../src/scanner/refresh.ts';
import { readProject } from '../../scripts/seed-demo.ts';
import { api } from '../src/api/app.ts';
import { remedies } from '../src/advisor/remedy.ts';

const snap = async (ref: string, asOf?: string) =>
  (await q('select * from snapshot where repo = $1 and ref = $2 and ($3::timestamptz is null or as_of = $3) order by id desc limit 1', ['acme/shop', ref, asOf ?? null]))[0];

beforeAll(async () => {
  await q('drop schema public cascade; create schema public;');
  await migrate();
  process.env.ADVISORY_FEED_SKIP = '1';
  const feed = process.env.ADVISORY_FEED;
  delete process.env.ADVISORY_FEED; // the simulated advisory arrives later, in the refresh test
  await seed();
  process.env.ADVISORY_FEED = feed;
});
afterAll(() => pool.end());

describe('scan pipeline (replay fixtures)', () => {
  it('main is green and the chalk 4 → 5 MR needs a code change at src/log.js:1', async () => {
    expect((await snap('main', '2025-08-01T10:00:00Z')).counts.red).toBe(0);
    const s = await snap('chalk-5');
    const [advice] = await q('select data from advice where snapshot_id = $1 and package = $2', [s.id, 'chalk']);
    expect(advice.data.verdict).toBe('NEEDS_CHANGE');
    expect(advice.data.items[0]).toMatchObject({ file: 'src/log.js', line: 1 });
    expect(advice.data.items[0].problem).toMatch(/ERR_REQUIRE_ESM/);
  });

  it('a patch bump needs no change; a transitive-only change is path-only', async () => {
    const [debug] = await q('select data from advice where snapshot_id = $1', [(await snap('debug-4.3.7')).id]);
    expect(debug.data.verdict).toBe('NO_CHANGE');
    const paths = await q('select data from advice where snapshot_id = $1', [(await snap('ms-override')).id]);
    expect(paths.every((a) => a.data.verdict === 'PATH_ONLY')).toBe(true);
    expect(paths[0].data.summary).toMatch(/reaches you via/);
  });

  it('replays Sept 8 2025 honestly: cooldown at 13:30, OSV records by 18:00, posts by Sept 9', async () => {
    const at = async (asOf: string) => (await q('select pv, reasons from snapshot_pv where snapshot_id = $1 and color = 2 order by pv', [(await snap('deps-sept-8', asOf)).id]));
    const early = await at('2025-09-08T13:30:00Z');
    expect(early.map((r) => r.pv)).toEqual(['chalk@5.6.1', 'debug@4.4.2']);
    expect(early.flatMap((r) => r.reasons.map((x: any) => x.code))).toEqual(['cooldown', 'cooldown']);
    expect((await at('2025-09-08T18:00:00Z')).flatMap((r) => r.reasons.map((x: any) => x.code))).toContain('malicious');
    expect((await at('2025-09-09T13:00:00Z')).flatMap((r) => r.reasons.map((x: any) => x.code))).toContain('security-post');
    expect((await snap('deps-sept-8', '2025-09-08T13:30:00Z')).gate).toEqual({ pass: false, undecidedReds: ['chalk@5.6.1', 'debug@4.4.2'] });
  });

  it('an accepted decision clears the gate on re-scan', async () => {
    for (const pv of ['chalk@5.6.1', 'debug@4.4.2']) await q("insert into decision (repo, pv, action, reason, expires_at) values ('acme/shop', $1, 'accept', 'test', '2025-09-10T00:00:00Z')", [pv]);
    const r = await scan({ ...readProject(new URL('../../demo/scenarios/d-replay-2025-09-08', import.meta.url).pathname), repo: 'acme/shop', ref: 'deps-sept-8', asOf: '2025-09-08T13:30:00Z' });
    expect(r.gate.pass).toBe(true);
    const late = await scan({ ...readProject(new URL('../../demo/scenarios/d-replay-2025-09-08', import.meta.url).pathname), repo: 'acme/shop', ref: 'deps-sept-8', asOf: '2025-09-11T13:30:00Z' });
    expect(late.gate.pass).toBe(false); // the decision expired
  });

  it('reuses the graph for an identical lockfile', async () => {
    const before = (await q('select count(*)::int as n from graph'))[0].n;
    await scan({ ...readProject(new URL('../../demo/shop', import.meta.url).pathname), repo: 'acme/shop', ref: 'main', asOf: '2025-08-02T00:00:00Z' });
    expect((await q('select count(*)::int as n from graph'))[0].n).toBe(before);
  });

  it('one new advisory re-colours every repo that contains the package', async () => {
    const { flipped } = await refresh('2026-10-25T12:00:00Z');
    const ms = flipped.find((f) => f.pv === 'ms@2.1.2');
    expect(ms?.to).toBe(2);
    expect(ms?.repos.sort()).toEqual(['acme/admin', 'acme/shop']);
  });

  it('says where the code uses each red package, what to change it to, why and the sources', async () => {
    const [chalk] = await remedies((await snap('deps-sept-8', '2025-09-08T18:00:00Z')).id, ['chalk@5.6.1']);
    expect(chalk.usedIn[0]).toMatchObject({ file: 'src/log.js', line: 1, code: "import chalk from 'chalk';" });
    expect(chalk.usedIn[0].calls.map((c) => c.name)).toEqual(['green', 'yellow', 'red']);
    expect(chalk.action).toMatchObject({ kind: 'pin', version: '5.6.0', packageJson: { after: '"chalk": "5.6.0"' } });
    expect(chalk.alternatives.map((a) => a.name)).toContain('util.styleText');
    expect(chalk.sources.map((s) => s.url)).toContain('https://osv.dev/vulnerability/MAL-2025-46969');
    // a refresh keeps the scan's usage, so a package flagged later still points at the code that pulls it in
    const ms = (await remedies((await snap('main')).id)).find((r) => r.pv === 'ms@2.1.2')!;
    expect(ms).toMatchObject({ usedBy: 'debug', action: { kind: 'upgrade', version: '2.1.3', packageJson: { before: null, after: '"overrides": { "ms": "2.1.3" }' } } });
    expect(ms.usedIn[0]).toMatchObject({ file: 'src/server.js', code: "const debug = require('debug')('shop:server');" });
  });
});

describe('api', () => {
  it('serves state, graph binary, pv details, sbom and watchers', async () => {
    const s = await snap('deps-sept-8', '2025-09-08T18:00:00Z');
    const state = await (await api.request(`/api/snapshots/${s.id}/state`)).json();
    const bin = Buffer.from(await (await api.request(`/api/graphs/${state.lockfileSha}.bin`)).arrayBuffer());
    expect(bin.toString('ascii', 0, 4)).toBe('DMAP');
    expect(Buffer.from(state.color, 'base64').length).toBe(bin.readUInt32LE(8));
    const pv = await (await api.request(`/api/pv?pv=chalk@5.6.1&snapshot=${s.id}`)).json();
    expect(pv.fingerprint).toMatchObject({ id: 'chalk-debug-2025', matched: 4 });
    const sbom = await (await api.request(`/api/snapshots/${s.id}/sbom.cdx.json`)).json();
    expect(sbom.vulnerabilities.map((v: any) => v.id)).toEqual(expect.arrayContaining(['MAL-2025-46969', 'MAL-2025-46974']));
    const watchers = await (await api.request('/api/watchers')).json();
    expect(watchers.sources.length).toBe(7);
    expect((await api.request('/api/decisions', { method: 'POST', body: '{}' })).status).toBe(400);
  });
});
