import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, pool, q } from '../src/db/db.ts';
import { assess, COLOR, gateFor, parsePolicy } from '../src/scanner/rules.ts';
import { scan } from '../src/scanner/scan.ts';
import { readProject } from '../../scripts/seed-demo.ts';

const AS_OF = '2025-09-08T13:30:00Z';
const facts = (over: any = {}) => ({ publishedAt: '2025-01-01T00:00:00Z', publisher: 'alice', maintainers: ['alice'], installScripts: [], provenance: false, unpublished: false,
  previous: { version: '1.0.0', publisher: 'alice', maintainers: ['alice'], provenance: false, installScripts: [] }, weeklyDownloads: 5_000_000, ...over });
const POLICY = `
cooldown_hours: 48
block_on: [red, amber]
allow:
  - pkg: debug@~4.4.0
    reason: pinned by the logging team
licenses:
  deny: [AGPL-3.0]
`;

describe('.depmap.yml policy', () => {
  it('parses YAML with defaults and rejects typos', () => {
    expect(parsePolicy()).toEqual({ cooldown_hours: 24, block_on: ['red'], allow: [], licenses: { deny: [] } });
    expect(parsePolicy(POLICY)).toMatchObject({ cooldown_hours: 48, block_on: ['red', 'amber'], allow: [{ pkg: 'debug@~4.4.0' }], licenses: { deny: ['AGPL-3.0'] } });
    expect(parsePolicy('{"block_on": ["amber"]}').block_on).toEqual(['amber']);
    expect(() => parsePolicy('cooldown_hour: 48')).toThrow(/\.depmap\.yml/);
    expect(() => parsePolicy('block_on: [blue]')).toThrow(/block_on/);
  });

  it('applies cooldown_hours to the too-fresh rule', () => {
    const thirtyHours = facts({ publishedAt: '2025-09-07T07:30:00Z' });
    expect(assess('a', '1.0.1', thirtyHours, [], AS_OF).reasons.map((r) => r.code)).toEqual(['recent']);
    const a = assess('a', '1.0.1', thirtyHours, [], AS_OF, [], false, parsePolicy(POLICY));
    expect(a.color).toBe(COLOR.red);
    expect(a.reasons[0]).toMatchObject({ code: 'cooldown', policy: 'cooldown_hours: 48' });
    expect(assess('a', '1.0.1', facts({ publishedAt: '2025-09-03T13:30:00Z' }), [], AS_OF, [], false, parsePolicy('cooldown_hours: 48')).reasons.map((r) => r.code)).toEqual(['recent']);
    expect(assess('a', '1.0.1', facts({ publishedAt: '2025-09-03T13:30:00Z' }), [], AS_OF).reasons).toEqual([]);
  });

  it('turns a denied license red, including -only and -or-later variants', () => {
    const p = parsePolicy(POLICY);
    const a = assess('a', '1.0.0', facts({ license: 'AGPL-3.0-only' }), [], AS_OF, [], false, p);
    expect(a.color).toBe(COLOR.red);
    expect(a.reasons).toEqual([expect.objectContaining({ code: 'license-denied', policy: 'licenses.deny: AGPL-3.0' })]);
    expect(assess('a', '1.0.0', facts({ license: 'MIT' }), [], AS_OF, [], false, p).color).toBe(COLOR.green);
  });

  it('gates on block_on colours, skips decided and allowed packages, and names the rule', () => {
    const states = [
      { color: COLOR.green, reasons: [] },
      { color: COLOR.amber, reasons: [{ code: 'recent', severity: 'amber' as const, text: '', url: '' }] },
      { color: COLOR.red, reasons: [{ code: 'cooldown', severity: 'red' as const, text: '', url: '', policy: 'cooldown_hours: 48' }] },
      { color: COLOR.red, reasons: [] },
      { color: COLOR.red, reasons: [] },
    ];
    const pvs = ['root@1.0.0', 'ms@2.1.3', 'chalk@5.6.1', 'debug@4.4.2', 'left-pad@1.3.0'];
    expect(gateFor(pvs, states, new Set(['left-pad@1.3.0']), parsePolicy())).toMatchObject({ pass: false, undecidedReds: ['chalk@5.6.1', 'debug@4.4.2'] });
    const g = gateFor(pvs, states, new Set(['left-pad@1.3.0']), parsePolicy(POLICY));
    expect(g.undecidedReds).toEqual(['ms@2.1.3', 'chalk@5.6.1']);
    expect(g.blocked).toEqual([{ pv: 'ms@2.1.3', rule: 'block_on: amber' }, { pv: 'chalk@5.6.1', rule: 'block_on: red · cooldown_hours: 48' }]);
    expect(g.allowed).toEqual([{ pv: 'debug@4.4.2', rule: 'allow: debug@~4.4.0', reason: 'pinned by the logging team' }]);
    expect(gateFor(pvs, states, new Set(), parsePolicy('allow: [{ pkg: debug@^5, reason: x }]')).undecidedReds).toContain('debug@4.4.2');
  });
});

describe('policy in a scan (replay fixtures)', () => {
  beforeAll(() => migrate());
  afterAll(() => pool.end());

  it('stores the policy on the snapshot and gates with it', async () => {
    const r = await scan({ ...readProject(new URL('../../demo/scenarios/d-replay-2025-09-08', import.meta.url).pathname), repo: 'acme/policy', ref: 'main', asOf: AS_OF, policy: POLICY });
    expect(r.gate.blocked.map((b) => b.pv)).toContain('chalk@5.6.1');
    expect(r.gate.blocked.find((b) => b.pv === 'chalk@5.6.1')?.rule).toBe('block_on: red · cooldown_hours: 48');
    expect(r.gate.allowed.map((a) => a.pv)).toEqual(['debug@4.4.2']);
    const [snap] = await q('select policy, gate from snapshot where id = $1', [r.snapshotId]);
    expect(snap.policy.cooldown_hours).toBe(48);
    expect(snap.gate.pass).toBe(false);
  });
});
