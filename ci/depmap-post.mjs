// depmap:report (post): one MR note, created once and then updated, plus a scoped label; starts the Duo flow when the gate fails.
import { existsSync, readFileSync } from 'node:fs';
import { MARKER, MR, PROJECT, depmap, env, gitlab, readResult } from './depmap-lib.mjs';

const { receipt: r, metrics: m } = readResult();
if (!MR) {
  console.log('depmap post: not a merge request pipeline, nothing to post');
  process.exit(0);
}

let image = '';
if (existsSync('depmap.png')) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync('depmap.png')], { type: 'image/png' }), 'depmap.png');
  image = (await gitlab(`/projects/${PROJECT}/uploads`, { method: 'POST', form })).markdown;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const level = !r.gate.pass ? 'red' : r.counts.red > 0 || r.advice.some((a) => ['NEEDS_CHANGE', 'REVIEW'].includes(a.verdict)) ? 'amber' : 'green';
const c = r.counts, page = r.urls.page ?? r.urls.map;
const undecided = r.reds.filter((x) => x.undecided);
const handle = env.DEPMAP_FLOW_HANDLE ?? '@depmap';
// AI code changes are written in the background after the scan; give them a moment so the table can say "code change"
const aiOf = new Map(undecided.length ? (await depmap(`/api/snapshots/${r.snapshotId}/remedies?wait=60`).catch(() => [])).map((x) => [x.pv, x.ai]) : []);

// short like the PR bots people already skim (SonarQube, Socket, Codecov): a verdict, five rows, one next step, the rest one click away
const short = (t, n = 72) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
function why(red) {
  if (red.fingerprint) return `Looks like ${red.fingerprint.title} (${red.fingerprint.matched}/${red.fingerprint.total})`;
  const top = red.reasons.find((x) => x.code === 'malicious') ?? red.reasons.find((x) => /\(CRITICAL\)/.test(x.text)) ?? red.reasons[0];
  if (!top) return 'Risky';
  const text = top.text.replace(/^(?:GHSA|MAL|CVE)-[\w-]+ \((\w)(\w+)\): /, (_, a, b) => `${a}${b.toLowerCase()}: `).split(/\.\s/)[0];
  return `${short(text)}${red.reasons.length > 1 ? ` (+${red.reasons.length - 1})` : ''}`;
}
function fix(red) {
  const a = red.remedy?.action, ai = aiOf.get(red.pv)?.fix;
  const head = !a ? 'Decide' : a.kind === 'upgrade' ? `Upgrade to \`${a.version}\`` : a.kind === 'pin' ? `Pin \`${a.version}\`` : a.kind === 'replace' ? `Replace \`${red.remedy.name}\`` : 'Remove';
  return `${head}${ai?.needsCodeChange ? ' · code change' : ''}`;
}
const rank = (red) => (red.fingerprint || red.reasons.some((x) => x.code === 'malicious') ? 0 : red.reasons.some((x) => /critical/i.test(x.text)) ? 1 : 2);
const rows = [...undecided].sort((a, b) => rank(a) - rank(b)).slice(0, 5);

const out = [MARKER];
out.push(r.gate.pass
  ? `### ✅ depmap · Ready to merge${c.red ? ` · ${c.red} red package${c.red === 1 ? '' : 's'} accepted` : ''}`
  : `### 🔴 depmap · Merge blocked: ${undecided.length} risky package${undecided.length === 1 ? '' : 's'}`);
out.push('', `**[Open the fix list →](${page})** · ${c.total} packages · 🔴 ${c.red} · 🟠 ${c.amber} · 🟢 ${c.green}`);
if (rows.length) {
  out.push('', '| | Package | Why | Fix |', '|---|---|---|---|');
  for (const red of rows) out.push(`| 🔴 | [\`${red.pv}\`](${page}?pv=${encodeURIComponent(red.pv)}) | ${cell(why(red))} | ${fix(red)} |`);
  if (undecided.length > rows.length) out.push(`| | _…and ${undecided.length - rows.length} more_ | | [fix list](${page}) |`);
}
const changes = r.advice.filter((a) => ['NEEDS_CHANGE', 'REVIEW'].includes(a.verdict));
if (r.changed.length || changes.length) {
  const added = r.changed.filter((x) => x.change === 'added').length, up = r.changed.filter((x) => x.change.includes('→')).length;
  out.push('', `**This MR:** ${[added && `${added} added`, up && `${up} upgraded`].filter(Boolean).join(' · ') || 'no dependency changes'}${
    changes.map((a) => ` · \`${a.package}\` ${a.from} → ${a.to} needs a code change${a.items?.[0] ? ` at \`${a.items[0].file}:${a.items[0].line}\`` : ''}`).join('')}`);
}
out.push('', undecided.length
  ? `**Next:** comment \`${handle} fix all\` (or \`fix <package>\`) to get a fix merge request, or \`/depmap accept <package@version> 7d: <reason>\` to accept the risk.`
  : `**Next:** nothing to do.`);
if (image) out.push('', '<details><summary>Map of this change</summary>', '', image, '', '</details>');
out.push('', `<sub>depmap · pipeline ${r.pipelineId ?? '-'} · 0 GitLab credits${m ? ` · ${m.gco2e.toFixed(4)} gCO₂e` : ''} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`);
const body = out.join('\n');

const me = await gitlab('/user');
const notes = await gitlab(`/projects/${PROJECT}/merge_requests/${MR}/notes?sort=asc&per_page=100`);
const existing = notes.find((n) => n.body.includes(MARKER) && n.author.id === me.id);
const note = existing
  ? await gitlab(`/projects/${PROJECT}/merge_requests/${MR}/notes/${existing.id}`, { method: 'PUT', body: { body } })
  : await gitlab(`/projects/${PROJECT}/merge_requests/${MR}/notes`, { method: 'POST', body: { body } });
await gitlab(`/projects/${PROJECT}/merge_requests/${MR}`, { method: 'PUT', body: { add_labels: `depmap::${level}` } });
console.log(`depmap post: ${existing ? 'updated' : 'created'} note ${note.id} on !${MR}${image ? ' with the map image' : ''}; label depmap::${level}`);

if (!r.gate.pass && env.DEPMAP_START_FLOW === '1') {
  const goal = [
    `The depmap gate failed on merge request !${MR} (MergeRequest IID: ${MR}) of project ${PROJECT}.`,
    `Pipeline ${r.pipelineId}, job ${r.jobId} (depmap:scan) printed the receipt between BEGIN_DEPMAP_JSON and END_DEPMAP_JSON at the end of its log.`,
    `Read it with get_job_logs, then explain each undecided red package (${r.gate.undecidedReds.join(', ')}) in one MR note.`,
  ].join('\n');
  // GitLab without the Duo Agent Platform (CE, no add-on) answers 403/404: the note and the gate already did their job
  await gitlab('/ai/duo_workflows/workflows', {
    method: 'POST',
    body: { project_id: PROJECT, goal, ai_catalog_item_consumer_id: env.DEPMAP_FLOW_CONSUMER_ID ? Number(env.DEPMAP_FLOW_CONSUMER_ID) : undefined, start_workflow: true },
  }).then(
    (wf) => console.log(`depmap post: started Duo flow, workflow ${wf.id} (${wf.status})`),
    (e) => console.log(`depmap post: Duo flow not started (${e.status ?? e.message}); is the Duo Agent Platform enabled for this project?`),
  );
}
