import semver from 'semver';
import { all, resolveDocUrl } from 'module-replacements';
import { q } from '../db/db.ts';
import { parseLockfile, type DepGraph } from '../scanner/lockfile.ts';
import { advisoryDetail, type AdvisoryDetail } from '../scanner/osv.ts';
import { packument } from '../scanner/facts.ts';
import { shortestPath } from '../scanner/scan.ts';
import { findUsage } from './usage.ts';

type Source = { path: string; content: string };
export type Site = { file: string; line: number; code: string; snippet: { line: number; text: string }[]; calls: { line: number; code: string; name: string }[]; url?: string };
export type Usage = { sites: Record<string, Site[]>; ranges: Record<string, string>; pnpm: boolean };
type Edit = { before: string | null; after: string };
export type Remedy = {
  pv: string; name: string; version: string; color: number; direct: boolean; via: string[]; usedBy: string; usedIn: Site[];
  action: { kind: 'upgrade' | 'pin' | 'replace' | 'remove'; text: string; version?: string; packageJson?: Edit } | null;
  alternatives: { for: string; name: string; kind: string; text: string; example?: string; url?: string }[];
  why: string[]; sources: { label: string; url: string }[];
  ai?: { status: string; fix: any; error: string | null } | null;
  mrUrl?: string | null;
};

// at scan time, while the sources are here: where our code imports each direct dependency
export function collectUsage(g: DepGraph, sources: Source[], packageJson?: string, lockfile = ''): Usage {
  const pj = packageJson ? JSON.parse(packageJson) : {};
  const sites: Usage['sites'] = {};
  for (const name of new Set(g.nodes.filter((n) => n.direct).map((n) => n.name))) {
    // one site per import line: `import { a, b } from 'x'` yields a usage per specifier, so merge their call sites
    const byLine = new Map<string, ReturnType<typeof findUsage>[number]>();
    for (const u of findUsage(sources, name)) {
      const had = byLine.get(`${u.file}:${u.line}`);
      if (had) had.symbols.push(...u.symbols);
      else byLine.set(`${u.file}:${u.line}`, { ...u, symbols: [...u.symbols] });
    }
    const found = [...byLine.values()].slice(0, 10);
    if (!found.length) continue;
    sites[name] = found.map((u) => {
      const lines = sources.find((s) => s.path === u.file)!.content.split('\n');
      const from = Math.max(0, u.line - 3);
      return {
        file: u.file, line: u.line, code: u.code,
        snippet: lines.slice(from, u.line + 2).map((text, k) => ({ line: from + k + 1, text })),
        calls: u.symbols.filter((s) => s.line !== u.line).slice(0, 8).map((s) => ({ line: s.line, code: s.code, name: s.name })),
      };
    });
  }
  return { sites, ranges: { ...pj.devDependencies, ...pj.dependencies }, pnpm: !lockfile.trimStart().startsWith('{') };
}

// e18e module-replacements: native APIs, one-line snippets, or lighter packages
function replacementsFor(name: string): Remedy['alternatives'] {
  const m = (all.mappings as Record<string, any>)[name];
  if (!m) return [];
  const guide = resolveDocUrl(m.url);
  return m.replacements.map((id: string) => (all.replacements as Record<string, any>)[id]).filter(Boolean).map((r: any) => ({
    for: name, name: r.replacementModule ?? r.id, kind: r.type,
    text: r.description ?? (r.type === 'documented' ? `Switch to ${r.replacementModule}.` : r.type === 'native' ? `Use the built-in ${r.id}.` : `Use ${r.id}.`),
    example: r.example,
    url: resolveDocUrl(r.url) ?? guide ?? (r.replacementModule ? `https://www.npmjs.com/package/${r.replacementModule}` : undefined),
  }));
}

// the newest release before the flagged one that no advisory covers and nobody deprecated
async function lastClean(name: string, version: string, details: AdvisoryDetail[]) {
  const doc = await packument(name);
  if (!doc || !semver.valid(version)) return null;
  const at = doc.time[version];
  return Object.keys(doc.versions)
    .filter((v) => semver.valid(v) && !semver.prerelease(v) && semver.lt(v, version) && (!at || !doc.time[v] || doc.time[v] < at) && !doc.versions[v].deprecated)
    .filter((v) => !details.some((d) => d.affected.some((r) => semver.satisfies(v, r))))
    .sort(semver.rcompare)[0] ?? null;
}

async function remedy(g: DepGraph, row: any, usage: Usage): Promise<Remedy | null> {
  const i = g.nodes.findIndex((n) => n.pv === row.pv);
  if (i < 0) return null;
  const n = g.nodes[i];
  const via = shortestPath(g, i).slice(1);
  const usedBy = via[0] ?? n.name;
  const npm = (v: string) => `https://www.npmjs.com/package/${n.name}/v/${v}`;
  const edit = (v: string, exact: boolean): Edit => n.direct
    ? { before: `"${n.name}": "${usage.ranges[n.name] ?? n.version}"`, after: `"${n.name}": "${exact ? v : `^${v}`}"` }
    : { before: null, after: usage.pnpm ? `"pnpm": { "overrides": { "${n.name}": "${exact ? v : `^${v}`}" } }` : `"overrides": { "${n.name}": "${exact ? v : `^${v}`}" }` };

  const details = (await Promise.all((row.advisories ?? []).map((a: any) => advisoryDetail(a.id, n.name, n.version).catch(() => null)))).filter(Boolean) as AdvisoryDetail[];
  const fixes = details.map((d) => d.fixedIn?.version);
  const alternatives = replacementsFor(usedBy);
  let action: Remedy['action'] = null;
  if (details.length && fixes.every(Boolean)) {
    const v = (fixes as string[]).sort(semver.compare).at(-1)!;
    action = { kind: 'upgrade', version: v, packageJson: edit(v, false),
      text: `Upgrade ${n.name} to ${v}, the first release that fixes ${details.length === 1 ? details[0].id : `all ${details.length} advisories`}${n.direct ? '' : ` (it comes in through ${via.join(' → ')}; an override forces the fixed version)`}.`
        + (semver.valid(n.version) && semver.major(v) > semver.major(n.version) ? ` That is a major upgrade from ${n.version}: read its migration notes and run your tests.` : '') };
  } else if (row.color === 2 || details.length) {
    const v = await lastClean(n.name, n.version, details);
    if (v) action = { kind: 'pin', version: v, packageJson: edit(v, true),
      text: details.length
        ? `No release fixes ${details.map((d) => d.id).join(', ')} yet: pin ${n.name} to ${v}, the last release before ${n.version} that no advisory covers.`
        : `Pin ${n.name} to ${v}, the last release before the flagged ${n.version}.` };
  }
  if (!action && alternatives.length && usedBy === n.name) action = { kind: 'replace', text: `Replace ${n.name}: ${alternatives[0].text}` };
  if (!action && row.reasons.some((r: any) => r.code === 'deprecated')) action = { kind: 'remove', text: `${n.name} is deprecated; remove it or move to a maintained package.` };

  const sources = [
    ...(row.advisories ?? []).map((a: any) => ({ label: a.id, url: a.url })),
    ...row.reasons.filter((r: any) => r.url).map((r: any) => ({ label: r.code, url: r.url })),
    ...(action?.version ? [{ label: `${n.name}@${action.version} on npm`, url: npm(action.version) }] : []),
    ...details.flatMap((d) => d.fixLinks.slice(0, 2).map((url) => ({ label: `${d.id} fix`, url }))),
    ...alternatives.filter((a) => a.url).map((a) => ({ label: a.name, url: a.url! })),
  ];
  return {
    pv: n.pv, name: n.name, version: n.version, color: row.color, direct: n.direct, via, usedBy, usedIn: usage.sites[usedBy] ?? [],
    action, alternatives,
    why: [...new Set([...row.reasons.map((r: any) => r.text), ...(row.advisories ?? []).map((a: any) => a.summary)
      .filter((t: string) => t && !row.reasons.some((r: any) => r.text.includes(t)))])],
    sources: sources.filter((s, k) => s.url && sources.findIndex((x) => x.url === s.url) === k),
  };
}

export async function remedies(snapshotId: number, only?: string[]): Promise<Remedy[]> {
  const [s] = await q('select s.repo, s.usage, s.web_url, s.commit_sha, g.lockfile from snapshot s join graph g using (lockfile_sha) where s.id = $1', [snapshotId]);
  if (!s) return [];
  const rows = await q(`select pv, color, reasons, advisories from snapshot_pv where snapshot_id = $1 and color in (1, 2) ${only ? 'and pv = any($2)' : ''}
    order by color desc, pv limit 40`, only ? [snapshotId, only] : [snapshotId]);
  const g = parseLockfile(s.lockfile);
  const usage: Usage = s.usage ?? { sites: {}, ranges: {}, pnpm: false };
  // code locations link to the file on GitLab at the scanned commit
  const blob = (file: string, line: number) => (s.web_url && /^[0-9a-f]{40}$/.test(s.commit_sha ?? '') ? `${s.web_url}/-/blob/${s.commit_sha}/${file.split('/').map(encodeURIComponent).join('/')}#L${line}` : undefined);
  const ai = new Map((await q('select pv, status, result, error from ai_fix where snapshot_id = $1', [snapshotId])).map((a) => [a.pv, {
    status: a.status, error: a.error, fix: a.result && { ...a.result, edits: a.result.edits.map((e: any) => ({ ...e, url: blob(e.file, e.startLine) })) },
  }]));
  const mrs = new Map((await q("select distinct on (pv) pv, mr_url from decision where repo = $1 and action = 'fix' order by pv, id desc", [s.repo])).map((d) => [d.pv, d.mr_url]));
  return (await Promise.all(rows.map((r) => remedy(g, r, usage)))).filter(Boolean)
    .map((r) => ({ ...r!, usedIn: r!.usedIn.map((u) => ({ ...u, url: blob(u.file, u.line) })), ai: ai.get(r!.pv) ?? null, mrUrl: mrs.get(r!.pv) ?? null }));
}
