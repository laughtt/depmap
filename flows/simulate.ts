// Local stand-in for the Duo Agent Platform runtime: validates a v1 flow, walks entry_point through the routers,
// and runs each component with LLM_MODE=mock (deterministic, does what the prompt says) or claude (Anthropic API).
// Tools are real GitLab REST calls against GITLAB_URL, so the same flow wiring is exercised end to end.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseDecisionCommands } from '../ci/depmap-lib.mjs';

const { parse } = createRequire(new URL('../server/package.json', import.meta.url))('yaml');
export const FLOW_FILE = new URL('./depmap.flow.yml', import.meta.url).pathname;
const TYPES = ['AgentComponent', 'OneOffComponent', 'DeterministicStepComponent', 'HumanInputComponent'];
const LOG_TAIL = 150 * 1024;

async function gl(path: string, init: RequestInit = {}) {
  const res = await fetch(`${process.env.GITLAB_URL}/api/v4${path.replace(/^\/api\/v4/, '')}`, {
    ...init, headers: { authorization: `Bearer ${process.env.GITLAB_TOKEN}`, 'content-type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitLab ${res.status} on ${path}: ${text.slice(0, 200)}`);
  return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}

const schema = (props: Record<string, string>, required = Object.keys(props)) =>
  ({ type: 'object', properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])), required });

export const TOOLS: Record<string, { description: string; input_schema: object; run: (a: any) => Promise<any> }> = {
  get_job_logs: {
    description: 'Get the trace of a CI job (only the last 150 KiB are returned).',
    input_schema: schema({ project_id: 'string', job_id: 'integer' }),
    run: async (a) => Buffer.from(String(await gl(`/projects/${encodeURIComponent(a.project_id)}/jobs/${a.job_id}/trace`))).subarray(-LOG_TAIL).toString(),
  },
  get_merge_request: {
    description: 'Get a merge request by project and IID.',
    input_schema: schema({ project_id: 'string', merge_request_iid: 'integer' }),
    run: (a) => gl(`/projects/${encodeURIComponent(a.project_id)}/merge_requests/${a.merge_request_iid}`),
  },
  gitlab_api_get: {
    description: 'GET any GitLab REST API v4 endpoint, e.g. /projects/1/pipelines/2/jobs.',
    input_schema: schema({ endpoint: 'string' }),
    run: (a) => gl(String(a.endpoint)),
  },
  create_merge_request_note: {
    description: 'Post a comment (Markdown) on a merge request.',
    input_schema: schema({ project_id: 'string', merge_request_iid: 'integer', body: 'string' }),
    run: (a) => gl(`/projects/${encodeURIComponent(a.project_id)}/merge_requests/${a.merge_request_iid}/notes`, { method: 'POST', body: JSON.stringify({ body: a.body }) }),
  },
  get_repository_file: {
    description: 'Get the raw content of a file in a repository at a ref.',
    input_schema: schema({ project_id: 'string', file_path: 'string', ref: 'string' }),
    run: (a) => gl(`/projects/${encodeURIComponent(a.project_id)}/repository/files/${encodeURIComponent(a.file_path)}/raw?ref=${encodeURIComponent(a.ref)}`).then(String),
  },
  create_commit: {
    description: 'Create a commit on a branch (created from start_branch when new) with update/create actions: [{action, file_path, content}].',
    input_schema: { type: 'object', properties: { project_id: { type: 'string' }, branch: { type: 'string' }, start_branch: { type: 'string' }, commit_message: { type: 'string' },
      actions: { type: 'array', items: { type: 'object', properties: { action: { type: 'string' }, file_path: { type: 'string' }, content: { type: 'string' } }, required: ['action', 'file_path', 'content'] } } },
      required: ['project_id', 'branch', 'commit_message', 'actions'] },
    run: (a) => gl(`/projects/${encodeURIComponent(a.project_id)}/repository/commits`, { method: 'POST', body: JSON.stringify(a) }),
  },
  create_merge_request: {
    description: 'Open a merge request.',
    input_schema: schema({ project_id: 'string', source_branch: 'string', target_branch: 'string', title: 'string', description: 'string' }),
    run: (a) => gl(`/projects/${encodeURIComponent(a.project_id)}/merge_requests`, { method: 'POST', body: JSON.stringify(a) }),
  },
  create_issue_note: {
    description: 'Post a comment (Markdown) on an issue.',
    input_schema: schema({ project_id: 'string', issue_iid: 'integer', body: 'string' }),
    run: (a) => gl(`/projects/${encodeURIComponent(a.project_id)}/issues/${a.issue_iid}/notes`, { method: 'POST', body: JSON.stringify({ body: a.body }) }),
  },
};

export function validateFlow(doc: any): string[] {
  const errors: string[] = [];
  if (doc?.version !== 'v1') errors.push('version must be "v1"');
  if (doc?.environment !== 'ambient') errors.push('environment must be "ambient"');
  const components: any[] = Array.isArray(doc?.components) ? doc.components : [];
  if (!components.length) errors.push('components must be a non-empty list');
  const names = new Set(components.map((c) => c.name));
  if (names.size !== components.length) errors.push('component names must be unique');
  const prompts = new Map((Array.isArray(doc?.prompts) ? doc.prompts : []).map((p: any) => [p.prompt_id, p]));
  for (const c of components) {
    if (!TYPES.includes(c.type)) errors.push(`component ${c.name}: unknown type ${c.type}`);
    if (['AgentComponent', 'OneOffComponent'].includes(c.type)) {
      const p: any = prompts.get(c.prompt_id);
      if (!p) errors.push(`component ${c.name}: prompt ${c.prompt_id} is missing`);
      else if (!p.prompt_template?.system || !p.prompt_template?.user || !Array.isArray(p.unit_primitives)) errors.push(`prompt ${c.prompt_id}: needs prompt_template.system, prompt_template.user and unit_primitives`);
    }
    for (const t of c.toolset ?? []) if (!TOOLS[t]) errors.push(`component ${c.name}: tool ${t} is not available in the simulator`);
    for (const i of c.inputs ?? []) {
      const ref = String(i.from ?? '').match(/^context:([\w-]+)\.final_answer/)?.[1];
      if (ref && !names.has(ref)) errors.push(`component ${c.name}: input from unknown component ${ref}`);
    }
  }
  const target = (t: string, from: string) => t === 'end' || names.has(t) || errors.push(`router from ${from}: unknown target ${t}`);
  for (const r of doc?.routers ?? []) {
    if (!names.has(r.from)) errors.push(`router: unknown source ${r.from}`);
    if (r.to) target(r.to, r.from);
    else if (r.condition?.routes) for (const t of Object.values(r.condition.routes)) target(String(t), r.from);
    else errors.push(`router from ${r.from}: needs "to" or "condition.routes"`);
    if (r.condition?.default_route) target(r.condition.default_route, r.from);
  }
  if (!names.has(doc?.flow?.entry_point)) errors.push(`flow.entry_point ${doc?.flow?.entry_point} is not a component`);
  return errors;
}

const lookup = (ctx: any, from: string) => from.replace(/^context:/, '').split('.').reduce((o, k) => o?.[k], ctx);
const render = (tpl: string, vars: Record<string, unknown>) => tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => String(vars[k] ?? ''));

function next(doc: any, from: string, ctx: any): string {
  const r = (doc.routers ?? []).find((x: any) => x.from === from);
  if (!r) return 'end';
  if (r.to) return r.to;
  const value = String(lookup(ctx, r.condition.input) ?? '').trim();
  const routes = r.condition.routes;
  return routes[value] ?? routes[value.split(/\s/)[0]] ?? routes.default_route ?? r.condition.default_route ?? 'end';
}

// start/receipt let one component run on its own, e.g. the fixer against a receipt saved from a depmap:scan job
export async function runFlow(doc: any, goal: string, projectId: string, mode = process.env.LLM_MODE ?? 'mock', start?: string, receipt?: string) {
  const ctx: any = { goal, project_id: projectId, ...(receipt && { reader: { final_answer: receipt } }) };
  const byName = new Map(doc.components.map((c: any) => [c.name, c]));
  for (let name = start ?? doc.flow.entry_point, steps = 0; name !== 'end' && steps < 20; name = next(doc, name, ctx), steps++) {
    const comp: any = byName.get(name);
    const inputs = Object.fromEntries((comp.inputs ?? []).map((i: any) => [i.as, lookup(ctx, i.from)]));
    const call = async (tool: string, args: any) => {
      if (!comp.toolset?.includes(tool)) throw new Error(`${name} may not call ${tool}`);
      const out = await TOOLS[tool].run(args);
      console.log(`  [tool] ${name} -> ${tool} ${JSON.stringify(args).slice(0, 160)} -> ${typeof out === 'string' ? `${out.length} chars` : 'ok'}`);
      return out;
    };
    console.log(`[component] ${name} (${comp.type}, ${mode})`);
    const prompt = doc.prompts.find((p: any) => p.prompt_id === comp.prompt_id);
    const answer = mode === 'claude' ? await claude(comp, prompt, inputs, call) : await MOCK[name](inputs, call);
    ctx[name] = { final_answer: answer };
    console.log(`[final_answer] ${name}: ${answer.length > 200 ? `${answer.slice(0, 200)}…` : answer}`);
  }
  return ctx;
}

async function claude(comp: any, prompt: any, inputs: any, call: (t: string, a: any) => Promise<any>) {
  const tools = (comp.toolset ?? []).map((n: string) => ({ name: n, description: TOOLS[n].description, input_schema: TOOLS[n].input_schema }));
  const messages: any[] = [{ role: 'user', content: render(prompt.prompt_template.user, inputs) }];
  for (let turn = 0; turn < 12; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': String(process.env.ANTHROPIC_API_KEY), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.AI_MODEL ?? 'claude-haiku-5-5', max_tokens: 16000, system: render(prompt.prompt_template.system, inputs), tools, messages }),
    });
    const msg = await res.json();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(msg).slice(0, 300)}`);
    if (msg.stop_reason === 'refusal') throw new Error(`model declined: ${msg.stop_details?.category ?? 'unknown'}`);
    messages.push({ role: 'assistant', content: msg.content });
    const uses = msg.content.filter((b: any) => b.type === 'tool_use');
    if (!uses.length) return msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
    messages.push({
      role: 'user',
      content: await Promise.all(uses.map(async (u: any) => {
        try {
          const out = await call(u.name, u.input);
          return { type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out) };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: u.id, content: (e as Error).message, is_error: true };
        }
      })),
    });
  }
  throw new Error(`${comp.name}: no final answer after 12 turns`);
}

// mock mode: deterministic logic that follows each prompt, using only the receipt and real tool calls
const MOCK: Record<string, (inputs: any, call: (t: string, a: any) => Promise<any>) => Promise<string>> = {
  async reader({ goal, project_id }, call) {
    const iid = Number(goal.match(/MergeRequest IID:\s*(\d+)|merge request !(\d+)|"merge_request":\s*\{[^}]*"iid":\s*(\d+)/i)?.slice(1).find(Boolean));
    if (!iid) return 'SKIP';
    await call('get_merge_request', { project_id, merge_request_iid: iid });
    let jobId = Number(goal.match(/\bjob (\d+)/i)?.[1]) || null;
    if (!jobId) {
      const [pipeline] = await call('gitlab_api_get', { endpoint: `/projects/${project_id}/merge_requests/${iid}/pipelines` });
      const jobs = pipeline ? await call('gitlab_api_get', { endpoint: `/projects/${project_id}/pipelines/${pipeline.id}/jobs` }) : [];
      jobId = jobs.find((j: any) => j.name === 'depmap:scan')?.id ?? null;
    }
    if (!jobId) return 'SKIP';
    const log: string = await call('get_job_logs', { project_id, job_id: jobId });
    return [...log.matchAll(/BEGIN_DEPMAP_JSON\s*\n([\s\S]*?)\n\s*END_DEPMAP_JSON/g)].at(-1)?.[1].trim() ?? 'SKIP';
  },

  async triage({ goal }) {
    return /(@depmap|\/depmap)\s+(fix|patch|upgrade)\b/i.test(goal) ? 'FIX' : 'EXPLAIN';
  },
  async fixer({ receipt, goal }, call) {
    const r = JSON.parse(receipt), named = goal.match(/fix\s+(@?[\w./-]+)/i)?.[1];
    const red = r.reds.find((x: any) => named && (x.pv === named || x.pv.startsWith(`${named}@`))) ?? r.reds.find((x: any) => x.undecided);
    const rm = red?.remedy, project_id = String(r.projectId);
    if (!rm?.action?.version) {
      await call('create_merge_request_note', { project_id, merge_request_iid: r.mrIid, body: `depmap: ${red?.pv ?? 'this package'} has no version to move to; replace it by hand.` });
      return 'no fix';
    }
    const pj = JSON.parse(await call('get_repository_file', { project_id, file_path: 'package.json', ref: r.ref }));
    const section = ['dependencies', 'devDependencies'].find((k) => pj[k]?.[rm.name]);
    if (rm.direct && section) pj[section][rm.name] = rm.action.kind === 'pin' ? rm.action.version : `^${rm.action.version}`;
    else pj.overrides = { ...pj.overrides, [rm.name]: rm.action.kind === 'pin' ? rm.action.version : `^${rm.action.version}` };
    const branch = `depmap/fix-${rm.name.replace(/[@/]/g, '-').replace(/^-/, '')}-${rm.action.version}`;
    await call('create_commit', { project_id, branch, start_branch: r.ref, commit_message: `depmap: ${rm.action.kind} ${rm.name} to ${rm.action.version}`,
      actions: [{ action: 'update', file_path: 'package.json', content: `${JSON.stringify(pj, null, 2)}\n` }] });
    const mr = await call('create_merge_request', { project_id, source_branch: branch, target_branch: r.ref, title: `Fix ${red.pv}: ${rm.action.kind} ${rm.name} to ${rm.action.version}`,
      description: `${rm.action.text}\n\n${red.reasons.map((x: any) => `- ${x.text}`).join('\n')}\n\nThe depmap:relock job regenerates the lockfile in this merge request's pipeline.` });
    await call('create_merge_request_note', { project_id, merge_request_iid: r.mrIid, body: `Opened !${mr.iid} to fix ${red.pv}: ${mr.web_url}` });
    return `opened !${mr.iid}`;
  },
  async investigator({ receipt, goal }, call) {
    const r = JSON.parse(receipt);
    const previous = (pv: string) => r.changed.find((c: any) => c.pv === pv)?.change.split(' → ')[0];
    const name = (pv: string) => pv.replace(/@[^@]*$/, '');
    const out: string[] = [];
    if (goal.startsWith('Input:')) {
      const comment = goal.slice(6, goal.lastIndexOf('\nContext:')).trim();
      const cmds = parseDecisionCommands([{ id: 0, body: comment, author: { username: 'human' } }]);
      out.push(`**What your comment will do** (MR !${r.mrIid})`, '');
      for (const d of cmds) {
        const red = r.reds.find((x: any) => x.pv === d.pv);
        const others = r.gate.undecidedReds.filter((pv: string) => pv !== d.pv && !cmds.some((c) => c.pv === pv));
        if (d.action === 'accept') {
          out.push(`- \`/depmap accept ${d.pv}${d.days ? ` ${d.days}d` : ''}\` records an acceptance for **${r.repo}**${d.days ? `, valid for ${d.days} day${d.days > 1 ? 's' : ''}` : ' with no expiry'}. The next pipeline reads it before scanning.`);
          out.push(`- The gate stops failing on \`${d.pv}\`. ${others.length ? `It still fails on ${others.map((p: string) => `\`${p}\``).join(', ')} unless another comment decides ${others.length > 1 ? 'them' : 'it'} too.` : 'No other red package is waiting, so the gate passes.'}`);
          out.push(`- The risk is unchanged: ${red ? red.reasons.map((x: any) => x.text).join(' ') : 'the package stays red on the map'} It stays red on the map, marked as decided.`);
          if (d.days) out.push(`- When the acceptance expires the gate fails again, unless the version changed. Safer: \`/depmap pin ${name(d.pv)}@${previous(d.pv) ?? '<previous>'}: <reason>\` and revert the bump.`);
        } else {
          out.push(`- \`/depmap pin ${d.pv}\` records that this repo should stay on that version. A pin is not a pass: the gate clears once the red version is gone from the lockfile.`);
        }
      }
      if (!cmds.length) out.push('I found no `/depmap accept` or `/depmap pin` command in your comment.', '', `Undecided red packages: ${r.gate.undecidedReds.map((p: string) => `\`${p}\``).join(', ') || 'none'}.`);
    } else {
      const undecided = r.reds.filter((x: any) => x.undecided);
      if (!undecided.length) return 'Nothing to investigate: every red package already has a decision.';
      out.push(`**depmap investigation** · MR !${r.mrIid} · pipeline ${r.pipelineId} · job ${r.jobId}`);
      for (const red of undecided) {
        const fp = red.fingerprint;
        const prev = previous(red.pv);
        const young = red.reasons.some((x: any) => ['cooldown', 'recent'].includes(x.code));
        out.push('', `**\`${red.pv}\`** needs a decision.`);
        out.push(`- **What happened:** ${red.reasons.map((x: any) => `${x.text} ([${x.code}](${x.url}))`).join(' ')}`);
        out.push(`- **What the fingerprint means:** ${fp ? `it matches ${fp.matched} of ${fp.total} signals of *${fp.title}* ([background](${fp.url})). ${fp.matched === fp.total ? 'A full match means this release has the shape of a hijacked publish, not a normal update.' : 'A partial match is a warning sign, not proof.'}` : 'no known attack fingerprint matches; the reasons above stand on their own.'}`);
        out.push(`- **Safest action:** ${prev && prev !== 'added' ? `stay on the version this MR replaces: revert to \`${name(red.pv)}@${prev}\` and comment \`/depmap pin ${name(red.pv)}@${prev}: suspected malicious release\`.` : `remove \`${red.pv}\` from this MR.`}${red.fixed ? ` A fixed version exists: \`${red.fixed}\`.` : ''}${young ? ' If you need the upgrade, wait out the cooldown and take the next clean release.' : ''} Only if you have verified the tarball: \`/depmap accept ${red.pv} 1d: <evidence>\`.`);
      }
    }
    out.push('', `<sub>depmap flow · read job ${r.jobId} with get_job_logs · no code was run</sub>`);
    const body = out.join('\n');
    await call('create_merge_request_note', { project_id: r.projectId, merge_request_iid: r.mrIid, body });
    return body;
  },
};

if (import.meta.main) {
  const file = process.argv.find((a) => a.endsWith('.yml')) ?? FLOW_FILE;
  const doc = parse(readFileSync(file, 'utf8'));
  const errors = validateFlow(doc);
  if (errors.length) {
    console.error(`flow ${file} is invalid:\n- ${errors.join('\n- ')}`);
    process.exit(1);
  }
  if (process.argv.includes('--validate')) {
    console.log(`flow ${file} is valid: ${doc.components.length} components, entry ${doc.flow.entry_point}`);
    process.exit(0);
  }
  const mode = process.env.LLM_MODE === 'claude' && process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock';
  console.log(`[flow] workflow ${process.env.DUO_WORKFLOW_ID ?? '-'} on project ${process.env.DUO_PROJECT_ID} (${mode})`);
  const arg = (k: string) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined;
  const receipt = arg('--receipt') && readFileSync(arg('--receipt')!, 'utf8');
  await runFlow(doc, process.env.DUO_WORKFLOW_GOAL ?? process.argv.at(-1)!, String(process.env.DUO_PROJECT_ID ?? '1'), mode, arg('--start'), receipt || undefined);
  console.log('[flow] finished');
}
