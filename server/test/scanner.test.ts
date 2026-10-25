import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseLockfile } from '../src/scanner/lockfile.ts';
import { assess, oneEdit, COLOR } from '../src/scanner/rules.ts';
import { matchFingerprint } from '../src/scanner/fingerprints.ts';
import { encodeGraph } from '../src/scanner/codec.ts';
import { findUsage } from '../src/advisor/usage.ts';

const demo = (p: string) => readFileSync(new URL(`../../demo/${p}`, import.meta.url), 'utf8');
const facts = (over: any = {}) => ({ publishedAt: '2025-01-01T00:00:00Z', publisher: 'alice', maintainers: ['alice'], installScripts: [], provenance: false, unpublished: false,
  previous: { version: '1.0.0', publisher: 'alice', maintainers: ['alice'], provenance: false, installScripts: [] }, weeklyDownloads: 5_000_000, ...over });
const AS_OF = '2025-09-08T13:30:00Z';

describe('lockfiles', () => {
  it('parses npm v3 with nested installs and dedupes by name@version', () => {
    const g = parseLockfile(demo('shop/package-lock.json'));
    expect(g.nodes[0]).toMatchObject({ root: true, depth: 0, pv: 'shop@1.0.0' });
    expect(g.nodes.filter((n) => n.direct).map((n) => n.name).sort()).toEqual(['chalk', 'debug', 'express']);
    const pvs = g.nodes.map((n) => n.pv);
    expect(pvs).toContain('debug@2.6.9');
    expect(pvs).toContain('ms@2.0.0');
    expect(new Set(pvs).size).toBe(pvs.length);
    expect(g.nodes.every((n) => n.depth < 255)).toBe(true);
  });

  it('parses pnpm v9 with importers, peers and dev flags', () => {
    const g = parseLockfile(readFileSync(new URL('../../pnpm-lock.yaml', import.meta.url), 'utf8'));
    const hono = g.nodes.find((n) => n.name === '@hono/node-server');
    expect(hono?.version).not.toContain('(');
    expect(g.nodes.find((n) => n.name === 'vitest')?.dev).toBe(true);
    expect(g.nodes.find((n) => n.name === 'hono')?.dev).toBe(false);
    expect(g.nodes.every((n) => n.depth < 255)).toBe(true);
  });

  it('encodes the contract binary header', () => {
    const g = parseLockfile(demo('shop/package-lock.json'));
    const b = encodeGraph(g);
    expect(b.toString('ascii', 0, 4)).toBe('DMAP');
    expect(b.readUInt32LE(8)).toBe(g.nodes.length);
    expect(b.readUInt32LE(12)).toBe(g.edges.length);
  });
});

describe('rules', () => {
  it('holds a version younger than the cooldown as red', () => {
    const a = assess('chalk', '5.6.1', facts({ publishedAt: '2025-09-08T13:13:05Z' }), [], AS_OF);
    expect(a.color).toBe(COLOR.red);
    expect(a.reasons[0].code).toBe('cooldown');
    expect(a.reasons[0].text).toMatch(/17 minutes/);
  });

  it('marks malicious advisories red and dev-only vulnerable tools amber', () => {
    const mal = { id: 'MAL-1', kind: 'malicious' as const, summary: 'x', severity: 'CRITICAL' as const, published: '2025-01-01', fixed: [], url: 'u' };
    const vuln = { ...mal, id: 'GHSA-1', kind: 'vuln' as const, severity: 'HIGH' as const, fixed: ['2.0.0'] };
    expect(assess('a', '1.0.0', facts(), [mal], AS_OF, [], true).color).toBe(COLOR.red);
    expect(assess('a', '1.0.0', facts(), [vuln], AS_OF).color).toBe(COLOR.red);
    expect(assess('a', '1.0.0', facts(), [vuln], AS_OF, [], true).color).toBe(COLOR.amber);
  });

  it('flags a recent publisher handover but not maintainers taking turns or trusted publishing', () => {
    const recent = { publishedAt: '2025-08-01T00:00:00Z' };
    expect(assess('a', '1.0.1', facts({ ...recent, publisher: 'mallory' }), [], AS_OF).reasons.map((r) => r.code)).toContain('new-publisher');
    expect(assess('a', '1.0.1', facts({ ...recent, publisher: 'bob', previous: { version: '1.0.0', publisher: 'alice', maintainers: ['alice', 'bob'], provenance: false, installScripts: [] } }), [], AS_OF).reasons).toEqual([]);
    expect(assess('a', '1.0.1', facts({ ...recent, publisher: 'GitHub Actions', provenance: true }), [], AS_OF).reasons).toEqual([]);
  });

  it('does not let a replay know a version was unpublished later', () => {
    expect(assess('a', '1.0.0', facts({ unpublished: true }), [], AS_OF).reasons.map((r) => r.code)).not.toContain('unpublished');
    expect(assess('a', '1.0.0', facts({ unpublished: true }), [], new Date().toISOString()).reasons.map((r) => r.code)).toContain('unpublished');
  });

  it('detects one-edit typosquats', () => {
    expect(oneEdit('chalk', 'chalks')).toBe(true);
    expect(oneEdit('lodash', 'lodahs')).toBe(true);
    expect(oneEdit('react', 'preact')).toBe(true);
    expect(oneEdit('express', 'express')).toBe(false);
    expect(oneEdit('axios', 'bios')).toBe(false);
  });
});

describe('fingerprints', () => {
  it('needs an anomaly: a fresh popular release alone is only a cooldown hold', () => {
    expect(matchFingerprint(new Set(['very-new', 'popular', 'same-publisher', 'no-install-script']))).toBeNull();
  });
  it('matches chalk/debug once the version is known malicious', () => {
    const m = matchFingerprint(new Set(['malicious', 'very-new', 'popular', 'same-publisher', 'no-install-script']));
    expect(m).toMatchObject({ id: 'chalk-debug-2025', matched: 4, total: 4 });
  });
  it('matches Shai-Hulud on a new install script', () => {
    expect(matchFingerprint(new Set(['very-new', 'install-script-added', 'same-publisher', 'provenance-dropped']))?.id).toBe('shai-hulud-2025');
  });
});

describe('usage scanner', () => {
  it('finds require bindings, member calls and call sites', () => {
    const u = findUsage([{ path: 'src/log.js', content: demo('shop/src/log.js') }], 'chalk');
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ kind: 'require', binding: 'chalk', line: 1 });
    expect(u[0].symbols.map((s) => s.name).sort()).toEqual(['green', 'red', 'yellow']);
  });
  it('handles ESM default imports, immediate calls and destructuring', () => {
    const src = [
      { path: 'a.mjs', content: "import chalk from 'chalk';\nchalk.blue('x');" },
      { path: 'b.js', content: "const debug = require('debug')('app');\nconst { program } = require('commander');" },
    ];
    expect(findUsage(src, 'chalk')[0]).toMatchObject({ kind: 'import', style: 'default' });
    expect(findUsage(src, 'debug')[0].symbols[0].name).toBe('()');
    expect(findUsage(src, 'commander')[0]).toMatchObject({ style: 'named', symbols: [{ name: 'program' }] });
  });
});
