import { all, resolveDocUrl } from 'module-replacements';
import { q } from '../db/db.ts';
import { parseLockfile, type DepGraph } from '../scanner/lockfile.ts';
import type { Usage } from './remedy.ts';

export type SlimItem = {
  kind: 'unused' | 'native' | 'lighter' | 'heavy' | 'duplicate';
  name: string; versions: string[]; saves: number; text: string;
  command?: string; example?: string; url?: string | null; names?: string[];
};

// packages reachable from the root when the nodes in `skip` are taken out
function reach(g: DepGraph, out: number[][], skip: Set<number>) {
  const seen = new Set<number>([0]);
  for (const queue = [0]; queue.length;) for (const b of out[queue.pop()!]) if (!skip.has(b) && !seen.has(b)) seen.add(b), queue.push(b);
  return seen;
}

export async function slim(snapshotId: number) {
  const [s] = await q('select s.usage, g.lockfile from snapshot s join graph g using (lockfile_sha) where s.id = $1', [snapshotId]);
  if (!s) return null;
  const g = parseLockfile(s.lockfile);
  const usage: Usage = s.usage ?? { sites: {}, ranges: {}, pnpm: false };
  const out: number[][] = g.nodes.map(() => []);
  const parents = new Map<number, Set<string>>();
  for (const [a, b] of g.edges) {
    out[a].push(b);
    if (!g.nodes[a].root) (parents.get(b) ?? parents.set(b, new Set()).get(b)!).add(g.nodes[a].name);
  }
  const everything = reach(g, out, new Set());
  const total = everything.size - 1;
  const byName = new Map<string, number[]>();
  g.nodes.forEach((n, i) => !n.root && (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)!).push(i));
  // what disappears with a direct dependency: everything only reachable through it
  const saves = (name: string) => total - (reach(g, out, new Set(byName.get(name))).size - 1);
  const pm = (pnpm: string, npm: string) => (usage.pnpm ? pnpm : npm);
  const items: SlimItem[] = [];

  for (const name of new Set(g.nodes.filter((n) => n.direct).map((n) => n.name))) {
    const versions = byName.get(name)!.map((i) => g.nodes[i].version);
    const sites = usage.sites[name] ?? [];
    const byOthers = byName.get(name)!.some((i) => parents.get(i)?.size);
    const inScripts = (usage.scripts ?? '').includes(name.split('/').pop()!);
    if (usage.runtime?.includes(name) && Object.keys(usage.sites).length && !sites.length && !byOthers && !inScripts) {
      items.push({ kind: 'unused', name, versions, saves: saves(name), text: 'No scanned file imports it, no script runs it and no other package needs it.', command: pm(`pnpm remove ${name}`, `npm uninstall ${name}`) });
      continue;
    }
    const m = (all.mappings as Record<string, any>)[name];
    const r = m && (all.replacements as Record<string, any>)[m.replacements[0]];
    if (r && (r.type === 'native' || r.type === 'simple' || r.type === 'removal')) {
      items.push({ kind: 'native', name, versions, saves: saves(name), text: r.description ?? `Use the built-in ${r.id} instead.`, example: r.example, url: resolveDocUrl(r.url) ?? resolveDocUrl(m.url) });
      continue;
    }
    // heavy and lighter only matter for what ships, and only when there is somewhere lighter to go
    if (!usage.runtime?.includes(name) || r?.type !== 'documented') continue;
    const n = saves(name);
    if (sites.length === 1 && n >= 15) {
      items.push({ kind: 'heavy', name, versions, saves: n, text: `Imported in one place (${sites[0].file}:${sites[0].line}) but brings ${n} packages of its own; ${r.replacementModule} is lighter.`, url: resolveDocUrl(m.url) });
    } else if (n >= 5) {
      items.push({ kind: 'lighter', name, versions, saves: n, text: `${r.replacementModule} does the same with fewer dependencies.`, url: resolveDocUrl(m.url) ?? `https://www.npmjs.com/package/${r.replacementModule}` });
    }
  }
  // one row for all duplicates; optional platform binaries (esbuild's per-OS packages) follow their parent and aren't counted
  const platform = /(^|[-/])(darwin|linux|win32|android|freebsd|openbsd|netbsd|sunos|aix|wasm32)([-/]|$)/;
  const dups = [...byName].filter(([name]) => !platform.test(name))
    .map(([name, idx]) => ({ name, extra: new Set(idx.filter((i) => !g.nodes[i].optional).map((i) => g.nodes[i].version)).size - 1 }))
    .filter((d) => d.extra > 0).sort((a, b) => b.extra - a.extra);
  const extra = dups.reduce((n, d) => n + d.extra, 0);
  if (extra) items.push({ kind: 'duplicate', name: `${dups.length} packages`, versions: [], saves: extra, names: dups.map((d) => d.name),
    text: `Installed in more than one version (${dups.slice(0, 4).map((d) => d.name).join(', ')}${dups.length > 4 ? ', …' : ''}); deduping can save up to ${extra}.`, command: pm('pnpm dedupe', 'npm dedupe') });
  const order = { unused: 0, native: 1, heavy: 2, lighter: 3, duplicate: 4 };
  items.sort((a, b) => order[a.kind] - order[b.kind] || b.saves - a.saves);
  // overlapping savings aren't added twice: removable is what goes when every non-duplicate suggestion is applied, plus extra copies
  // the headline doesn't count twice: packages that go with a suggestion, then extra copies among what stays
  const gone = new Set(items.filter((i) => i.kind !== 'duplicate').flatMap((i) => byName.get(i.name)!));
  const kept = reach(g, out, gone);
  const copies = new Map<string, Set<string>>();
  for (const i of kept) if (!g.nodes[i].root && !platform.test(g.nodes[i].name)) (copies.get(g.nodes[i].name) ?? copies.set(g.nodes[i].name, new Set()).get(g.nodes[i].name)!).add(g.nodes[i].version);
  const keptExtra = [...copies.values()].reduce((n, v) => n + v.size - 1, 0);
  return { total, removable: total - (kept.size - 1) + keptExtra, items };
}
