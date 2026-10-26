// depmap:report (post): one MR note, created once and then updated, plus a scoped label; starts the Duo flow when the gate fails.
import { existsSync, readFileSync } from 'node:fs';
import { MARKER, MR, PROJECT, env, gitlab, readResult } from './depmap-lib.mjs';

const { receipt: r } = readResult();
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
const c = r.counts;
const undecided = r.reds.filter((x) => x.undecided);
// AI code changes are written in the background after the scan; give them a moment before posting
const aiOf = new Map(r.reds.length ? (await depmap(`/api/snapshots/${r.snapshotId}/remedies?wait=90`).catch(() => [])).map((x) => [x.pv, x.ai]) : []);
const out = [
  MARKER,
  `### depmap · ${r.gate.pass ? 'Gate passed' : `Gate failed: ${undecided.length} red package${undecided.length === 1 ? '' : 's'} need a decision`}`,
  '',
  `**${c.total}** packages · **${c.red}** red · **${c.amber}** amber · **${c.green}** green${c.grey ? ` · ${c.grey} unknown` : ''} · \`depmap::${level}\``,
];
if (image) out.push('', image);
out.push('', `**[Open this push's page](${r.urls.page ?? r.urls.map})** (tree, what to do to merge, changes) · [full map](${r.urls.map}) · snapshot ${r.snapshotId}${r.asOf ? ` · risk as of ${r.asOf}` : ''}`);

if (r.changed.length) {
  out.push('', '#### Changed packages', '', '| Package | Change | Risk |', '|---|---|---|');
  for (const ch of r.changed) out.push(`| \`${cell(ch.pv.replace(/@[^@]*$/, ''))}\` | ${cell(ch.change)} | ${ch.color ?? '-'} |`);
}

if (r.reds.length) {
  out.push('', '#### Red packages', '');
  for (const red of r.reds) {
    const d = red.decision;
    out.push(`- **\`${red.pv}\`**: ${red.undecided ? '**needs a decision**' : `${{ accept: 'accepted', pin: 'pinned' }[d?.action] ?? 'decided'} by @${d?.by ?? '?'}${d?.expiresAt ? ` until ${d.expiresAt.slice(0, 16).replace('T', ' ')} UTC` : ''}`}`);
    for (const reason of red.reasons) out.push(`  - ${cell(reason.text)} ([${reason.code}](${reason.url}))`);
    const fp = red.fingerprint;
    if (fp) out.push(`  - Looks like **${fp.title}**: ${fp.matched} of ${fp.total} signals. ${cell(fp.summary)} ([background](${fp.url}))`);
    const rm = red.remedy;
    if (!rm) continue;
    const through = rm.usedBy !== rm.name ? ` through \`${rm.usedBy}\`` : '';
    for (const s of rm.usedIn.slice(0, 3)) out.push(`  - Used${through} in \`${s.file}:${s.line}\`: \`${cell(s.code)}\`${s.calls.length ? ` (also line${s.calls.length > 1 ? 's' : ''} ${s.calls.slice(0, 4).map((c) => c.line).join(', ')})` : ''}`);
    if (rm.action) out.push(`  - **Fix:** ${cell(rm.action.text)}${rm.action.packageJson ? ` In \`package.json\`: \`${cell(rm.action.packageJson.after)}\`` : ''}`);
    if (rm.alternatives.length) out.push(`  - Or replace \`${rm.alternatives[0].for}\` with ${rm.alternatives.slice(0, 3).map((a) => (a.url ? `[${a.name}](${a.url})` : a.name)).join(', ')}`);
    if (rm.sources.length) out.push(`  - Sources: ${rm.sources.slice(0, 6).map((s) => `[${cell(s.label)}](${s.url})`).join(' · ')}`);
    const ai = aiOf.get(red.pv)?.fix;
    if (ai) {
      out.push(`  - **AI code change** (${ai.model}, ${ai.confidence} confidence): ${ai.needsCodeChange ? '' : 'no code change is required. '}${cell(ai.summary)}`);
      for (const e of ai.edits) out.push('', `    \`${e.file}:${e.startLine}\` · ${e.required ? 'required' : 'optional'}: ${cell(e.why)}`, '', '    ```diff', ...e.before.split('\n').map((l) => `    -${l}`), ...e.after.split('\n').map((l) => `    +${l}`), '    ```');
      if (ai.sources.length) out.push(`    Read: ${ai.sources.slice(0, 4).map((s) => `[${cell(s.label)}](${s.url})`).join(' · ')}`);
    }
  }
}

if (r.advice.length) {
  out.push('', '#### Upgrade impact');
  for (const a of r.advice) {
    out.push('', `**\`${a.package}\` ${a.from} → ${a.to}** · \`${a.verdict}\`${a.direct ? '' : ' · transitive'}`, '', cell(a.summary));
    if (a.items?.length) {
      out.push('', '| Where | Code | Problem | Fix |', '|---|---|---|---|');
      for (const it of a.items) out.push(`| \`${it.file}:${it.line}\` | \`${cell(it.code)}\` | ${cell(it.problem)} | ${cell(it.fix)} |`);
      const alts = [...new Set(a.items.flatMap((it) => it.alternatives ?? []))];
      if (alts.length) out.push('', `Alternatives: ${alts.map(cell).join('; ')}`);
    }
    if (!a.direct && a.paths?.[0]) out.push('', `Reaches you via ${a.paths[0].join(' → ')}.`);
  }
}

out.push('', '#### How to proceed', '');
if (undecided.length) {
  out.push('Change the dependency, or comment one decision per package and re-run the pipeline:', '', '```');
  for (const red of undecided) {
    out.push(`/depmap accept ${red.pv} 1d: <why the risk is acceptable>`);
    const prev = r.changed.find((ch) => ch.pv === red.pv)?.change.split(' → ')[0];
    if (prev && prev !== 'added') out.push(`/depmap pin ${red.pv.replace(/@[^@]*$/, '')}@${prev}: <reason>`);
  }
  out.push('```');
} else out.push('Nothing to decide. To accept a red package later, comment `/depmap accept <pkg@version> <N>d: <reason>` and re-run the pipeline.');
out.push('', `<sub>Posted by depmap CI (pipeline ${r.pipelineId ?? '-'}, job ${r.jobId ?? '-'}) · this pipeline used 0 GitLab credits · updated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`);
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
