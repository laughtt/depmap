import { q } from '../db/db.ts';
import { parseLockfile } from './lockfile.ts';
import { assessGraph, countColors, saveDetails, lockfileOf } from './scan.ts';
import { COLOR } from './rules.ts';
import { DYN } from './codec.ts';
import { remedies } from '../advisor/remedy.ts';
import { queueAiFixes } from '../advisor/aifix.ts';

// The world changes without a commit: re-assess the head of every branch with today's advisories.
// Risk is a property of package@version, so one new advisory flips the same node in every repo that has it.
export async function refresh(asOf = new Date().toISOString()) {
  const heads = await q(`select distinct on (repo, coalesce(ref, '')) * from snapshot where kind in ('push', 'refresh') order by repo, coalesce(ref, ''), id desc`);
  const flipped = new Map<string, { pv: string; from: number; to: number; repos: string[] }>();
  for (const head of heads) {
    const g = parseLockfile(await lockfileOf(head.lockfile_sha));
    const states = await assessGraph(g, head.repo, asOf);
    const changes = g.nodes.map((n, i) => ({ pv: n.pv, from: head.color[i], to: states[i].color })).filter((c) => c.from !== c.to);
    if (!changes.length) continue;
    for (const c of changes) {
      const i = g.nodes.findIndex((n) => n.pv === c.pv);
      states[i].flags |= DYN.changed;
    }
    const counts = countColors(states, g);
    const reds = g.nodes.filter((_, i) => states[i].color === COLOR.red).map((n) => n.pv);
    const [snap] = await q(
      `insert into snapshot (repo, ref, commit_sha, kind, base_snapshot_id, lockfile_sha, as_of, color, flags, counts, gate, delta, usage, web_url)
       values ($1,$2,$3,'refresh',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
      [head.repo, head.ref, head.commit_sha, head.id, head.lockfile_sha, asOf, Buffer.from(states.map((s) => s.color)), Buffer.from(states.map((s) => s.flags)), counts,
        { pass: reds.length === 0, undecidedReds: reds }, { baseSnapshotId: head.id, added: [], removed: [], upgraded: [], colorChanged: changes }, head.usage, head.web_url],
    );
    await saveDetails(snap.id, g, states);
    await q('insert into snapshot_file (snapshot_id, path, content) select $1, path, content from snapshot_file where snapshot_id = $2', [snap.id, head.id]);
    await queueAiFixes(snap.id, await remedies(snap.id));
    for (const c of changes) {
      const f = flipped.get(c.pv) ?? flipped.set(c.pv, { ...c, repos: [] }).get(c.pv)!;
      f.repos.push(head.repo);
      const why = states[g.nodes.findIndex((n) => n.pv === c.pv)].reasons.map((r) => r.code);
      await q('insert into event (kind, repo, pv, snapshot_id, payload) values ($1,$2,$3,$4,$5)', ['advisory', head.repo, c.pv, snap.id, { from: c.from, to: c.to, reasons: why }]);
    }
  }
  return { flipped: [...flipped.values()] };
}
