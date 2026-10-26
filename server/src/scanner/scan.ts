import { createHash } from 'node:crypto';
import semver from 'semver';
import { q } from '../db/db.ts';
import { parseLockfile, type DepGraph } from './lockfile.ts';
import { encodeGraph, DYN } from './codec.ts';
import { packuments, versionFacts, weeklyDownloads, type VersionFacts } from './facts.ts';
import { advisoriesFor, type Advisory } from './osv.ts';
import { allowedBy, assess, COLOR, defaultPolicy, gateFor, parsePolicy, type Policy } from './rules.ts';
import { matchFingerprint, type FingerprintMatch } from './fingerprints.ts';
import { adviseUpgrade, type Advice } from '../advisor/advise.ts';
import { mentionsFor } from '../watchers/watchers.ts';
import { startMeter } from './sci.ts';
import { collectUsage, remedies } from '../advisor/remedy.ts';
import { queueAiFixes } from '../advisor/aifix.ts';

export type ScanInput = {
  repo: string;
  ref?: string;
  commitSha?: string;
  baseSha?: string;
  mrIid?: number;
  kind?: string;
  lockfile: string;
  packageJson?: string;
  sources?: { path: string; content: string }[];
  asOf?: string;
  webUrl?: string;
  policy?: string | object; // .depmap.yml text (or parsed)
};

export type NodeState = { color: number; flags: number; reasons: any[]; fingerprint: FingerprintMatch | null; advisories: Advisory[] };

export async function factsFor(g: DepGraph): Promise<Map<string, VersionFacts | null>> {
  const pvs = g.nodes.filter((n) => !n.root).map((n) => n.pv);
  const known = new Map<string, VersionFacts | null>((await q('select pv, facts from package_version where pv = any($1)', [pvs])).map((r) => [r.pv, r.facts]));
  const missing = g.nodes.filter((n) => !n.root && !known.has(n.pv));
  if (missing.length) {
    const names = [...new Set(missing.map((n) => n.name))];
    const [docs, downloads] = await Promise.all([packuments(names), weeklyDownloads(names)]);
    for (const n of missing) {
      const facts = versionFacts(docs.get(n.name) ?? null, n.version, downloads.get(n.name));
      known.set(n.pv, facts);
      await q('insert into package_version (pv, name, version, facts) values ($1,$2,$3,$4) on conflict (pv) do update set facts = excluded.facts, fetched_at = now()', [n.pv, n.name, n.version, facts]);
    }
  }
  return known;
}

export async function activeDecisions(repo: string, asOf: string) {
  return q('select * from decision where repo = $1 and (expires_at is null or expires_at > $2) order by id', [repo, asOf]);
}

// assess every node of a graph as of a moment; shared by scans and the world refresh
export async function assessGraph(g: DepGraph, repo: string, asOf: string, p: Policy = defaultPolicy): Promise<NodeState[]> {
  const facts = await factsFor(g);
  const advisories = await advisoriesFor(g.nodes.filter((n) => !n.root), asOf);
  const decided = new Set((await activeDecisions(repo, asOf)).filter((d) => d.action === 'accept').map((d) => d.pv));
  const mentions = await mentionsFor(g.nodes.filter((n) => !n.root), asOf);
  return g.nodes.map((n) => {
    if (n.root) return { color: COLOR.green, flags: 0, reasons: [], fingerprint: null, advisories: [] };
    const f = facts.get(n.pv) ?? null;
    const adv = advisories.get(n.pv) ?? [];
    const a = assess(n.name, n.version, f, adv, asOf, mentions.get(n.pv) ?? [], n.dev, p);
    const fingerprint = a.color === COLOR.green ? null : matchFingerprint(a.signals);
    const flags = (adv.some((x) => x.kind === 'vuln') ? DYN.vuln : 0) | (a.signals.has('malicious') ? DYN.malicious : 0) |
      (f?.deprecated ? DYN.deprecated : 0) | (decided.has(n.pv) || allowedBy(n.name, n.version, p) ? DYN.decided : 0) |
      (a.reasons.some((r) => r.code === 'recent' || r.code === 'cooldown') ? DYN.recent : 0) | (fingerprint ? DYN.fingerprint : 0);
    return { color: a.color, flags, reasons: a.reasons, fingerprint, advisories: adv };
  });
}

export function shortestPath(g: DepGraph, target: number): string[] {
  const parent = new Map<number, number>([[0, -1]]);
  const out: number[][] = g.nodes.map(() => []);
  for (const [a, b] of g.edges) out[a].push(b);
  const queue = [0];
  for (let h = 0; h < queue.length && !parent.has(target); h++) {
    for (const b of out[queue[h]]) if (!parent.has(b)) { parent.set(b, queue[h]); queue.push(b); }
  }
  const path: string[] = [];
  for (let i = target; i !== -1 && i !== undefined; i = parent.get(i)!) path.unshift(g.nodes[i].name);
  return path;
}

function versionsByName(g: DepGraph) {
  const m = new Map<string, Set<string>>();
  for (const n of g.nodes) if (!n.root) (m.get(n.name) ?? m.set(n.name, new Set()).get(n.name)!).add(n.version);
  return m;
}

const maxVersion = (vs: string[]) => vs.sort((a, b) => (semver.valid(a) && semver.valid(b) ? semver.compare(a, b) : a.localeCompare(b))).at(-1)!;

export function countColors(states: NodeState[], g: DepGraph) {
  const c = { total: 0, red: 0, amber: 0, green: 0, grey: 0 };
  states.forEach((s, i) => {
    if (g.nodes[i].root) return;
    c.total++;
    c[(['green', 'amber', 'red', 'grey'] as const)[s.color]]++;
  });
  return c;
}

async function findBase(input: ScanInput) {
  if (input.kind === 'crawl') return null;
  const rows = input.baseSha
    ? await q('select * from snapshot where repo = $1 and commit_sha = $2 order by id desc limit 1', [input.repo, input.baseSha])
    : await q('select * from snapshot where repo = $1 and ($2::text is null or ref = $2) order by id desc limit 1', [input.repo, input.ref ?? null]);
  return rows[0] ?? null;
}

export async function scan(input: ScanInput) {
  const meter = startMeter();
  const policy = parsePolicy(input.policy);
  const asOf = input.asOf ?? new Date().toISOString();
  const lockfileSha = createHash('sha256').update(input.lockfile).digest('hex');
  const g = parseLockfile(input.lockfile);
  await q('insert into graph (lockfile_sha, bin, pvs, lockfile) values ($1,$2,$3,$4) on conflict do nothing', [lockfileSha, encodeGraph(g), g.nodes.map((n) => n.pv), input.lockfile]);
  const edges = g.edges.filter(([a]) => !g.nodes[a].root);
  await q('insert into pv_edge (parent, child) select * from unnest($1::text[], $2::text[]) on conflict do nothing', [edges.map(([a]) => g.nodes[a].pv), edges.map(([, b]) => g.nodes[b].pv)]);
  const deps = g.nodes.filter((n) => !n.root);
  await q(`insert into pv_use (pv, runtime, direct, install) select * from unnest($1::text[], $2::bool[], $3::bool[], $4::bool[])
    on conflict (pv) do update set runtime = pv_use.runtime or excluded.runtime, direct = pv_use.direct or excluded.direct, install = pv_use.install or excluded.install`,
  [deps.map((n) => n.pv), deps.map((n) => !n.dev), deps.map((n) => n.direct), deps.map((n) => n.installScript)]);
  const states = await assessGraph(g, input.repo, asOf, policy);

  const base = await findBase(input);
  let delta: any = null;
  const advice: Advice[] = [];
  if (base) {
    const baseG = parseLockfile(await lockfileOf(base.lockfile_sha));
    const before = versionsByName(baseG);
    const after = versionsByName(g);
    const basePv = new Map((await q('select pv, color from snapshot_pv where snapshot_id = $1', [base.id])).map((r) => [r.pv, r.color]));
    const baseColor = (pv: string) => basePv.get(pv) ?? (baseG.nodes.some((n) => n.pv === pv) ? COLOR.green : undefined);
    delta = { baseSnapshotId: base.id, added: [] as string[], removed: [] as string[], upgraded: [] as any[], colorChanged: [] as any[] };
    for (const [name, vs] of after) {
      const old = before.get(name);
      if (!old) { for (const v of vs) delta.added.push(`${name}@${v}`); continue; }
      const gone = [...old].filter((v) => !vs.has(v));
      const fresh = [...vs].filter((v) => !old.has(v));
      // an override can consolidate onto a version already in the tree, so "to" may not be fresh
      if (gone.length) delta.upgraded.push({ name, from: maxVersion(gone), to: maxVersion(fresh.length ? fresh : [...vs]) });
      else for (const v of fresh) delta.added.push(`${name}@${v}`);
    }
    for (const [name, vs] of before) if (!after.has(name)) for (const v of vs) delta.removed.push(`${name}@${v}`);
    g.nodes.forEach((n, i) => {
      const was = baseColor(n.pv);
      if (!n.root && was !== undefined && was !== states[i].color) delta.colorChanged.push({ pv: n.pv, from: was, to: states[i].color });
      if (!n.root && (was === undefined || was !== states[i].color)) states[i].flags |= DYN.changed;
    });
    const rootDeps = (gr: DepGraph) => new Map(gr.edges.filter(([a]) => a === 0).map(([, b]) => [gr.nodes[b].name, gr.nodes[b].version]));
    const directBefore = rootDeps(baseG);
    const directAfter = rootDeps(g);
    for (const u of delta.upgraded) {
      const direct = directBefore.has(u.name) && directAfter.has(u.name) && directBefore.get(u.name) !== directAfter.get(u.name);
      const from = direct ? directBefore.get(u.name)! : u.from;
      const to = direct ? directAfter.get(u.name)! : u.to;
      const target = g.nodes.findIndex((n) => n.pv === `${u.name}@${to}`);
      advice.push(await adviseUpgrade({ name: u.name, from, to, direct, paths: target > 0 ? [shortestPath(g, target)] : [], sources: input.sources ?? [], packageJson: input.packageJson }));
    }
  }

  const decisions = await activeDecisions(input.repo, asOf);
  const accepted = new Set(decisions.filter((d) => d.action === 'accept').map((d) => d.pv));
  const gate = gateFor(g.nodes.map((n) => n.pv), states, accepted, policy);
  const { undecidedReds } = gate;
  const counts = countColors(states, g);
  const metrics = meter(counts.total);

  const usage = input.sources?.length ? collectUsage(g, input.sources, input.packageJson, input.lockfile) : null;
  const [snap] = await q(
    `insert into snapshot (repo, ref, commit_sha, kind, mr_iid, base_snapshot_id, lockfile_sha, as_of, color, flags, counts, gate, delta, metrics, usage, web_url, policy)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
    [input.repo, input.ref ?? null, input.commitSha ?? null, input.kind ?? (input.mrIid ? 'mr' : 'push'), input.mrIid ?? null, base?.id ?? null, lockfileSha, asOf,
      Buffer.from(states.map((s) => s.color)), Buffer.from(states.map((s) => s.flags)), counts, gate, delta, metrics,
      usage, input.webUrl ?? null, policy],
  );
  await saveDetails(snap.id, g, states);
  for (const a of advice) await q('insert into advice (snapshot_id, package, data) values ($1,$2,$3)', [snap.id, a.package, a]);
  await q('insert into event (kind, repo, snapshot_id, payload) values ($1,$2,$3,$4)', ['scan', input.repo, snap.id, { ref: input.ref, commitSha: input.commitSha, mrIid: input.mrIid, counts }]);
  for (const pv of undecidedReds) if (!delta || delta.colorChanged.some((c: any) => c.pv === pv) || delta.added.includes(pv) || delta.upgraded.some((u: any) => `${u.name}@${u.to}` === pv)) {
    await q('insert into event (kind, repo, pv, snapshot_id, payload) values ($1,$2,$3,$4,$5)', ['red', input.repo, pv, snap.id, { reasons: states[g.nodes.findIndex((n) => n.pv === pv)].reasons.map((r) => r.code) }]);
  }
  const used = new Set(Object.values(usage?.sites ?? {}).flat().map((s) => s.file));
  for (const f of (input.sources ?? []).filter((x) => used.has(x.path))) await q('insert into snapshot_file (snapshot_id, path, content) values ($1,$2,$3) on conflict do nothing', [snap.id, f.path, f.content]);
  const all = await remedies(snap.id);
  await queueAiFixes(snap.id, all);
  const fixes = new Map(all.map((r) => [r.pv, r]));
  const reds = g.nodes.flatMap((n, i) => (states[i].color === COLOR.red ? [{ pv: n.pv, reasons: states[i].reasons, fingerprint: states[i].fingerprint, remedy: fixes.get(n.pv) ?? null }] : []));
  return { snapshotId: snap.id, lockfileSha, asOf, counts, delta, advice, gate, metrics, reds, policy };
}

export async function saveDetails(snapshotId: number, g: DepGraph, states: NodeState[]) {
  const rows = g.nodes.map((n, i) => ({ n, s: states[i] })).filter(({ n, s }) => !n.root && (s.color !== COLOR.green || s.reasons.length));
  if (!rows.length) return;
  await q(
    `insert into snapshot_pv (snapshot_id, pv, color, reasons, fingerprint, advisories)
     select $1, x.pv, x.color, x.reasons, x.fingerprint, x.advisories from jsonb_to_recordset($2) as x(pv text, color int, reasons jsonb, fingerprint jsonb, advisories jsonb)`,
    [snapshotId, JSON.stringify(rows.map(({ n, s }) => ({ pv: n.pv, color: s.color, reasons: s.reasons, fingerprint: s.fingerprint, advisories: s.advisories })))],
  );
}

export async function lockfileOf(lockfileSha: string): Promise<string> {
  const [row] = await q('select lockfile from graph where lockfile_sha = $1', [lockfileSha]);
  return row.lockfile;
}
