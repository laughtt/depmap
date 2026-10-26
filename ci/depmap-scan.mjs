// depmap:scan: apply human decisions from MR notes, scan the lockfile, write depmap.json and print the receipt block last.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { API, APP, COLORS, MR, PROJECT, GITLAB, auth, env, depmap, gitlab, logger, parseDecisionCommands, registerJob } from './depmap-lib.mjs';

const dir = process.cwd(); // runners start jobs in CI_PROJECT_DIR
const repo = env.CI_PROJECT_PATH;
const ref = env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME || env.CI_COMMIT_REF_NAME;
const { log, trace } = logger();

const lockName = env.DEPMAP_LOCKFILE ?? ['package-lock.json', 'pnpm-lock.yaml'].find((f) => existsSync(join(dir, f)));
if (!repo || !lockName) {
  console.error('depmap: needs CI_PROJECT_PATH and a package-lock.json (or DEPMAP_LOCKFILE)');
  process.exit(2);
}

const SOURCE = /\.(m|c)?(j|t)sx?$/;
const sources = [];
const walk = (d) => {
  for (const f of readdirSync(d).sort()) {
    if (sources.length >= 200 || f === 'node_modules' || f.startsWith('.')) continue;
    const p = join(d, f);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (SOURCE.test(f) && st.size < 512_000) sources.push({ path: relative(dir, p), content: readFileSync(p, 'utf8') });
  }
};
walk(dir);

if (MR && GITLAB) {
  const notes = await gitlab(`/projects/${PROJECT}/merge_requests/${MR}/notes?sort=asc&per_page=100`);
  const applied = new Set((await depmap(`/api/events?repo=${encodeURIComponent(repo)}`)).filter((e) => e.kind === 'decision').map((e) => `${e.pv}|${e.payload?.reason}`));
  for (const d of parseDecisionCommands(notes)) {
    const reason = `${d.reason} (!${MR} note ${d.noteId})`;
    if (applied.has(`${d.pv}|${reason}`)) continue;
    const expiresAt = d.days ? new Date(Date.now() + d.days * 86_400_000).toISOString() : undefined;
    await depmap('/api/decisions', { repo, pv: d.pv, action: d.action, reason, by: d.by, expiresAt });
    log(`depmap: applied /depmap ${d.action} ${d.pv}${d.days ? ` for ${d.days}d` : ''} by @${d.by} (note ${d.noteId})`);
  }
}

const result = await depmap('/api/scan', {
  repo, ref, commitSha: env.CI_COMMIT_SHA, baseSha: env.CI_MERGE_REQUEST_DIFF_BASE_SHA || undefined, mrIid: MR,
  lockfile: readFileSync(join(dir, lockName), 'utf8'), packageJson: existsSync(join(dir, 'package.json')) ? readFileSync(join(dir, 'package.json'), 'utf8') : undefined,
  sources, asOf: env.DEPMAP_AS_OF || undefined, webUrl: env.CI_PROJECT_URL,
  policy: existsSync(join(dir, '.depmap.yml')) ? readFileSync(join(dir, '.depmap.yml'), 'utf8') : undefined,
});
const id = result.snapshotId;

// colours per package: names from the graph binary (§1 of the contract), colours from the snapshot state (§2)
const state = await depmap(`/api/snapshots/${id}/state`);
const bin = Buffer.from(await (await fetch(`${API}/api/graphs/${result.lockfileSha}.bin`, { headers: auth })).arrayBuffer());
const names = bin.subarray(bin.length - bin.readUInt32LE(16)).toString('utf8').split('\n');
const color = Buffer.from(state.color, 'base64');
const colorOf = new Map(names.map((pv, i) => [pv, COLORS[color[i]]]));

const reds = await Promise.all(names.filter((pv, i) => i > 0 && (color[i] === 2 || result.gate.undecidedReds.includes(pv))).slice(0, 25).map(async (pv) => {
  const d = await depmap(`/api/pv?pv=${encodeURIComponent(pv)}&snapshot=${id}`);
  const fp = d.fingerprint;
  return {
    pv, undecided: result.gate.undecidedReds.includes(pv), decision: d.decision,
    reasons: d.reasons.map((r) => ({ code: r.code, text: r.text, url: r.url })),
    fixed: d.advisories?.flatMap((a) => a.fixed ?? [])[0] ?? d.reasons.map((r) => r.text.match(/Fixed in ([\w.+-]+?)\.?$/)?.[1]).find(Boolean) ?? null,
    fingerprint: fp && { id: fp.id, title: fp.title, matched: fp.matched, total: fp.total, url: fp.url, summary: fp.summary },
    remedy: result.reds?.find((x) => x.pv === pv)?.remedy ?? null,
  };
}));

const delta = result.delta;
const changed = delta ? [
  ...delta.upgraded.map((u) => ({ pv: `${u.name}@${u.to}`, change: `${u.from} → ${u.to}` })),
  ...delta.added.map((pv) => ({ pv, change: 'added' })),
  ...delta.removed.map((pv) => ({ pv, change: 'removed' })),
].slice(0, 60).map((c) => ({ ...c, color: colorOf.get(c.pv) ?? null })) : [];

const receipt = {
  v: 1, repo, projectId: PROJECT, mrIid: MR ?? null, ref, commitSha: env.CI_COMMIT_SHA ?? null, pipelineId: env.CI_PIPELINE_ID ?? null, jobId: env.CI_JOB_ID ?? null,
  snapshotId: id, asOf: result.asOf, counts: result.counts, gate: result.gate,
  delta: delta && { baseSnapshotId: delta.baseSnapshotId, added: delta.added.length, removed: delta.removed.length, upgraded: delta.upgraded.length, colorChanged: delta.colorChanged.length },
  changed,
  advice: result.advice.map((a) => ({ package: a.package, from: a.from, to: a.to, direct: a.direct, verdict: a.verdict, summary: a.summary, items: a.items, paths: a.paths })),
  reds,
  urls: { page: `${APP}/repos/${repo}/scans/${id}`, map: `${APP}/repos/${repo}/map/${id}`, delta: `${API}/api/snapshots/${id}/delta` },
};
let block = JSON.stringify(receipt);
if (block.length > 95_000) {
  receipt.advice.forEach((a) => (a.items = a.items.slice(0, 3)));
  receipt.changed = receipt.changed.slice(0, 20);
  block = JSON.stringify(receipt);
}
writeFileSync(join(dir, 'depmap.json'), JSON.stringify({ ...result, snapshotId: id, receipt }, null, 2));

const c = result.counts;
log(`depmap: ${repo}@${ref} snapshot ${id}: ${c.total} packages, ${c.red} red, ${c.amber} amber, ${c.green} green, ${c.grey} grey`);
for (const a of receipt.advice) log(`depmap: upgrade ${a.package} ${a.from} → ${a.to}: ${a.verdict}`);
if (existsSync(join(dir, '.depmap.yml'))) log(`depmap: policy .depmap.yml ${JSON.stringify(result.policy)}`);
log(`depmap: gate ${result.gate.pass ? 'PASS' : `FAIL (${result.gate.undecidedReds.join(', ')})`}`);
log(`depmap: page ${receipt.urls.page}`);
// every pipeline publishes its page: a `depmap` commit status links the commit (and this pipeline) to it
if (GITLAB && env.CI_COMMIT_SHA && env.GITLAB_TOKEN) {
  await gitlab(`/projects/${PROJECT}/statuses/${env.CI_COMMIT_SHA}`, {
    method: 'POST',
    body: { state: result.gate.pass ? 'success' : 'failed', name: 'depmap', target_url: receipt.urls.page, pipeline_id: env.CI_PIPELINE_ID ? Number(env.CI_PIPELINE_ID) : undefined,
      description: `${c.total} packages · ${c.red} red · ${c.amber} amber${result.gate.pass ? '' : ' · blocked'}` },
  }).catch((e) => log(`depmap: commit status not set (${e.status ?? e.message})`));
}
log(`BEGIN_DEPMAP_JSON\n${block}\nEND_DEPMAP_JSON`);
await registerJob(trace());
