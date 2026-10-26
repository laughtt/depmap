// A local, in-memory GitLab speaking real v4 REST shapes, so the same clients work against gitlab.com.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { Hono, type Context } from 'hono';
import { serve } from '@hono/node-server';
import { marked } from 'marked';

const ROOT = new URL('../../../', import.meta.url).pathname;
const PORT = Number(process.env.MOCK_GITLAB_PORT ?? 8929);
const BASE = process.env.MOCK_GITLAB_URL ?? `http://localhost:${PORT}`;
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const now = () => new Date().toISOString();

type User = { id: number; username: string; name: string; state: string; avatar_url: string | null; web_url: string; bot: boolean };
const user = (id: number, username: string, name: string, bot = false): User => ({ id, username, name, state: 'active', avatar_url: null, web_url: `${BASE}/${username}`, bot });
export const DEMO = user(1, 'demo', 'Demo Owner');
export const SERVICE = user(2, 'ai-depmap-acme', 'depmap flow', true);
export const SERVICE_TOKEN = 'glpat-ai-depmap-acme';

function readTree(dir: string) {
  const base = join(ROOT, 'demo', dir);
  const files = new Map<string, string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d).sort()) {
      if (f === 'node_modules' || f.startsWith('.')) continue;
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.set(relative(base, p), readFileSync(p, 'utf8'));
    }
  };
  walk(base);
  return { files, sha: sha1([...files].map(([p, c]) => `${p}\0${c}`).join('\0')) };
}

const BRANCHES: Record<number, Record<string, string>> = {
  1: { main: 'shop', 'chalk-5': 'scenarios/a-chalk5', 'debug-4.3.7': 'scenarios/b-debug-patch', 'ms-override': 'scenarios/c-transitive', 'deps-sept-8': 'scenarios/d-replay-2025-09-08' },
  2: { main: 'admin' },
};
const repos = new Map(Object.entries(BRANCHES).map(([id, b]) => [Number(id), new Map(Object.entries(b).map(([ref, dir]) => [ref, readTree(dir)]))]));
export const branchSha = (projectId: number, ref: string) => repos.get(projectId)?.get(ref)?.sha;

const project = (id: number, path: string) => ({
  id, name: path, path, path_with_namespace: `acme/${path}`, name_with_namespace: `acme / ${path}`, description: `Demo ${path} service`,
  default_branch: 'main', visibility: 'private', web_url: `${BASE}/acme/${path}`, last_activity_at: '2025-09-08T13:30:00Z',
  namespace: { id: 10, name: 'acme', path: 'acme', kind: 'group', full_path: 'acme' }, permissions: { project_access: null, group_access: { access_level: 50 } },
});
const MRS: [number, string, string][] = [
  [1, 'chalk-5', 'Upgrade chalk to 5'],
  [2, 'debug-4.3.7', 'Bump debug to 4.3.7'],
  [3, 'ms-override', 'Override ms to 2.1.3'],
  [4, 'deps-sept-8', 'Refresh dependencies (Sept 8)'],
];

function fresh() {
  const main = branchSha(1, 'main')!;
  return {
    projects: [project(1, 'shop'), project(2, 'admin')],
    mrs: MRS.map(([iid, branch, title]) => ({
      id: 100 + iid, iid, project_id: 1, title, description: `Merges \`${branch}\` into \`main\`.`, state: 'opened', source_branch: branch, target_branch: 'main',
      author: DEMO, assignees: [] as User[], labels: [] as string[], sha: branchSha(1, branch), web_url: `${BASE}/acme/shop/-/merge_requests/${iid}`,
      diff_refs: { base_sha: main, head_sha: branchSha(1, branch), start_sha: main }, created_at: '2025-09-08T12:00:00Z', updated_at: '2025-09-08T12:00:00Z',
    })),
    notes: [] as any[],
    issues: [] as any[],
    uploads: new Map<string, { type: string; bytes: Uint8Array }>(),
    jobs: new Map<number, any>(),
    workflows: [] as any[],
    statuses: [] as any[],
    codes: new Map<string, { challenge: string; redirectUri: string; scope: string }>(),
    oauthTokens: new Set<string>(),
    calls: [] as { method: string; path: string; status: number; at: string }[],
    seq: 0,
  };
}
let S = fresh();
const nextId = () => ++S.seq;

type Env = { Variables: { user: User } };
export const app = new Hono<Env>();

app.use('*', async (c, next) => {
  await next();
  if (!c.req.path.startsWith('/mock/calls')) S.calls.push({ method: c.req.method, path: c.req.path, status: c.res.status, at: now() });
});

const tokenUser = (token: string) => (token.startsWith('glpat-') ? (token.includes('ai-depmap') ? SERVICE : DEMO) : S.oauthTokens.has(token) ? DEMO : null);

app.use('/api/v4/*', async (c, next) => {
  const token = c.req.header('private-token') ?? c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const u = tokenUser(token);
  if (!u) return c.json({ message: '401 Unauthorized' }, 401);
  c.set('user', u);
  await next();
});

const body = async (c: Context): Promise<any> => (c.req.header('content-type')?.includes('json') ? c.req.json() : c.req.parseBody());
const list = (v: unknown) => (v == null ? null : (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean));
const findProject = (id: string) => S.projects.find((p) => String(p.id) === id || p.path_with_namespace === id);
const notFound = (c: Context, what: string) => c.json({ message: `404 ${what} Not Found` }, 404);

// scoped labels (scope::value) replace any other label of the same scope, as on GitLab
function applyLabels(cur: string[], b: any) {
  let out = list(b.labels) ?? cur;
  for (const l of list(b.add_labels) ?? []) {
    const scope = l.includes('::') ? l.slice(0, l.lastIndexOf('::') + 2) : null;
    out = [...out.filter((x) => x !== l && !(scope && x.startsWith(scope))), l];
  }
  const rm = list(b.remove_labels) ?? [];
  return out.filter((x) => !rm.includes(x));
}

app.get('/api/v4/user', (c) => c.json({ ...c.get('user'), email: `${c.get('user').username}@acme.test`, is_admin: false }));

app.get('/api/v4/projects', (c) => {
  const search = c.req.query('search')?.toLowerCase();
  return c.json(S.projects.filter((p) => !search || p.path_with_namespace.includes(search)));
});

const P = '/api/v4/projects/:id';
app.get(P, (c) => findProject(c.req.param('id')) ? c.json(findProject(c.req.param('id'))) : notFound(c, 'Project'));

function branch(c: Context) {
  const p = findProject(c.req.param('id')!);
  const ref = c.req.query('ref') ?? c.req.param('ref') ?? 'main';
  const b = p && repos.get(p.id)!;
  return p && b && (b.get(ref) ?? [...b.values()].find((x) => x.sha === ref));
}

app.get(`${P}/repository/files/:path/raw`, (c) => {
  const content = branch(c)?.files.get(c.req.param('path'));
  return content == null ? notFound(c, 'File') : c.text(content);
});

app.get(`${P}/repository/tree`, (c) => {
  const b = branch(c);
  if (!b) return notFound(c, 'Tree');
  const recursive = c.req.query('recursive') === 'true';
  const paths = new Map<string, string>();
  for (const f of b.files.keys()) {
    const parts = f.split('/');
    parts.forEach((_, i) => paths.set(parts.slice(0, i + 1).join('/'), i === parts.length - 1 ? 'blob' : 'tree'));
  }
  return c.json([...paths].filter(([p]) => recursive || !p.includes('/')).map(([path, type]) => ({ id: sha1(path), name: basename(path), type, path, mode: type === 'tree' ? '040000' : '100644' })));
});

app.get(`${P}/repository/commits/:ref`, (c) => {
  const b = branch(c);
  if (!b) return notFound(c, 'Commit');
  return c.json({ id: b.sha, short_id: b.sha.slice(0, 8), title: `Update ${c.req.param('ref')}`, author_name: DEMO.name, created_at: '2025-09-08T12:00:00Z', parent_ids: [], web_url: `${BASE}/-/commit/${b.sha}` });
});

const findMr = (c: Context) => S.mrs.find((m) => m.project_id === findProject(c.req.param('id')!)?.id && m.iid === Number(c.req.param('iid')));
app.get(`${P}/merge_requests`, (c) => c.json(S.mrs.filter((m) => m.project_id === findProject(c.req.param('id'))?.id)));
app.get(`${P}/merge_requests/:iid`, (c) => findMr(c) ? c.json(findMr(c)) : notFound(c, 'Merge Request'));
app.put(`${P}/merge_requests/:iid`, async (c) => {
  const mr = findMr(c);
  if (!mr) return notFound(c, 'Merge Request');
  const b = await body(c);
  mr.labels = applyLabels(mr.labels, b);
  if (b.assignee_ids) mr.assignees = list(b.assignee_ids)!.map((id) => [DEMO, SERVICE].find((u) => u.id === Number(id))!).filter(Boolean);
  mr.updated_at = now();
  return c.json(mr);
});

function addNote(projectId: number, type: 'MergeRequest' | 'Issue', iid: number, text: string, author: User) {
  const note = { id: nextId(), type: null, body: text, author, created_at: now(), updated_at: now(), system: false, noteable_type: type, noteable_iid: iid, project_id: projectId };
  S.notes.push(note);
  if (type === 'MergeRequest' && !author.bot && /@depmap\b/.test(text)) {
    startWorkflow({ project_id: projectId, goal: `Input: ${text}\nContext: {MergeRequest IID: ${iid}}`, source: 'mention' });
  }
  return note;
}
const notesOf = (c: Context, type: string, iid: number) => {
  const items = S.notes.filter((n) => n.noteable_type === type && n.noteable_iid === iid && n.project_id === findProject(c.req.param('id')!)?.id);
  return c.req.query('sort') === 'asc' ? items : [...items].reverse();
};

app.get(`${P}/merge_requests/:iid/notes`, (c) => findMr(c) ? c.json(notesOf(c, 'MergeRequest', Number(c.req.param('iid')))) : notFound(c, 'Merge Request'));
app.post(`${P}/merge_requests/:iid/notes`, async (c) => {
  const mr = findMr(c);
  const b = await body(c);
  if (!mr) return notFound(c, 'Merge Request');
  if (!b.body) return c.json({ message: 'body is missing' }, 400);
  return c.json(addNote(mr.project_id, 'MergeRequest', mr.iid, String(b.body), c.get('user')), 201);
});
app.put(`${P}/merge_requests/:iid/notes/:noteId`, async (c) => {
  const note = S.notes.find((n) => n.id === Number(c.req.param('noteId')) && n.noteable_type === 'MergeRequest');
  if (!note) return notFound(c, 'Note');
  if (note.author.id !== c.get('user').id) return c.json({ message: '403 Forbidden' }, 403);
  Object.assign(note, { body: String((await body(c)).body), updated_at: now() });
  return c.json(note);
});

const pipelines = () => {
  const out = new Map<string, any>();
  for (const j of S.jobs.values()) {
    const key = `${j.pipeline.project_id}:${j.pipeline.id}`;
    const p = out.get(key) ?? out.set(key, { ...j.pipeline, status: 'success' }).get(key);
    if (j.status === 'failed') p.status = 'failed';
  }
  return [...out.values()].sort((a, b) => b.id - a.id);
};
app.get(`${P}/merge_requests/:iid/pipelines`, (c) => c.json(pipelines().filter((p) => p.mr_iid === Number(c.req.param('iid')) && p.project_id === findProject(c.req.param('id'))?.id)));
const projectId = (c: Context) => findProject(c.req.param('id')!)?.id;
app.get(`${P}/pipelines/:pid`, (c) => {
  const p = pipelines().find((x) => x.id === Number(c.req.param('pid')) && x.project_id === projectId(c));
  return p ? c.json(p) : notFound(c, 'Pipeline');
});
app.get(`${P}/pipelines/:pid/jobs`, (c) => c.json([...S.jobs.values()].filter((j) => j.pipeline.id === Number(c.req.param('pid')) && j.pipeline.project_id === projectId(c)).map(({ trace, ...j }) => j)));
app.get(`${P}/jobs/:jobId`, (c) => {
  const j = S.jobs.get(Number(c.req.param('jobId')));
  if (!j) return notFound(c, 'Job');
  const { trace, ...rest } = j;
  return c.json(rest);
});
app.get(`${P}/jobs/:jobId/trace`, (c) => {
  const j = S.jobs.get(Number(c.req.param('jobId')));
  return j ? c.text(j.trace) : notFound(c, 'Job');
});

app.post(`${P}/uploads`, async (c) => {
  const p = findProject(c.req.param('id'));
  const file = (await c.req.parseBody()).file;
  if (!p) return notFound(c, 'Project');
  if (!(file instanceof File)) return c.json({ message: 'file is missing' }, 400);
  const secret = randomBytes(16).toString('hex');
  const name = file.name.replace(/[^\w.-]/g, '_');
  S.uploads.set(`${secret}/${name}`, { type: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) });
  const alt = name.replace(/\.[^.]+$/, '');
  return c.json({ id: nextId(), alt, url: `/uploads/${secret}/${name}`, full_path: `/-/project/${p.id}/uploads/${secret}/${name}`, markdown: `![${alt}](/uploads/${secret}/${name})` }, 201);
});
app.post(`${P}/statuses/:sha`, async (c) => {
  const status = { id: nextId(), sha: c.req.param('sha'), ...(await c.req.json()), created_at: new Date().toISOString() };
  S.statuses.push(status);
  return c.json(status, 201);
});
app.get('/mock/statuses', (c) => c.json(S.statuses));
const serveUpload = (c: Context) => {
  const u = S.uploads.get(`${c.req.param('secret')}/${c.req.param('name')}`);
  return u ? c.body(u.bytes as Uint8Array<ArrayBuffer>, 200, { 'content-type': u.type }) : c.text('Not found', 404);
};
app.get('/uploads/:secret/:name', serveUpload);
app.get('/-/project/:id/uploads/:secret/:name', serveUpload);
app.get('/:ns/:project/uploads/:secret/:name', serveUpload);

const findIssue = (c: Context) => S.issues.find((i) => i.project_id === findProject(c.req.param('id')!)?.id && i.iid === Number(c.req.param('iid')));
app.post(`${P}/issues`, async (c) => {
  const p = findProject(c.req.param('id'));
  const b = await body(c);
  if (!p) return notFound(c, 'Project');
  if (!b.title) return c.json({ message: 'title is missing' }, 400);
  const iid = S.issues.filter((i) => i.project_id === p.id).length + 1;
  const issue = {
    id: nextId(), iid, project_id: p.id, title: String(b.title), description: b.description ?? '', state: 'opened', labels: list(b.labels) ?? [],
    assignees: (list(b.assignee_ids) ?? []).map((id) => [DEMO, SERVICE].find((u) => u.id === Number(id))).filter(Boolean), author: c.get('user'),
    created_at: now(), updated_at: now(), web_url: `${p.web_url}/-/issues/${iid}`,
  };
  S.issues.push(issue);
  return c.json(issue, 201);
});
app.get(`${P}/issues`, (c) => {
  const search = c.req.query('search')?.toLowerCase();
  const labels = list(c.req.query('labels')) ?? [];
  const state = c.req.query('state') ?? 'all';
  return c.json(S.issues.filter((i) => i.project_id === findProject(c.req.param('id'))?.id && (state === 'all' || i.state === state) &&
    (!search || `${i.title} ${i.description}`.toLowerCase().includes(search)) && labels.every((l) => i.labels.includes(l))).reverse());
});
app.get(`${P}/issues/:iid`, (c) => findIssue(c) ? c.json(findIssue(c)) : notFound(c, 'Issue'));
app.put(`${P}/issues/:iid`, async (c) => {
  const issue = findIssue(c);
  if (!issue) return notFound(c, 'Issue');
  const b = await body(c);
  issue.labels = applyLabels(issue.labels, b);
  if (b.assignee_ids) issue.assignees = list(b.assignee_ids)!.map((id) => [DEMO, SERVICE].find((u) => u.id === Number(id))).filter(Boolean);
  if (b.state_event) issue.state = b.state_event === 'close' ? 'closed' : 'opened';
  issue.updated_at = now();
  return c.json(issue);
});
app.get(`${P}/issues/:iid/notes`, (c) => c.json(notesOf(c, 'Issue', Number(c.req.param('iid')))));
app.post(`${P}/issues/:iid/notes`, async (c) => {
  const issue = findIssue(c);
  const b = await body(c);
  if (!issue) return notFound(c, 'Issue');
  return c.json(addNote(issue.project_id, 'Issue', issue.iid, String(b.body), c.get('user')), 201);
});

// Duo Agent Platform: starting a flow over REST (the fallback when triggers are not available)
function startWorkflow({ project_id, goal, source, consumer }: { project_id: number; goal: string; source: string; consumer?: unknown }) {
  const wf = { id: nextId(), project_id, goal, source, ai_catalog_item_consumer_id: consumer ?? null, status: 'running', log: '', created_at: now(), finished_at: null as string | null };
  S.workflows.push(wf);
  const child = spawn(process.execPath, [join(ROOT, 'flows/simulate.ts')], {
    env: { ...process.env, GITLAB_URL: BASE, GITLAB_TOKEN: SERVICE_TOKEN, DUO_WORKFLOW_GOAL: goal, DUO_PROJECT_ID: String(project_id), DUO_WORKFLOW_ID: String(wf.id) },
  });
  child.stdout.on('data', (d) => (wf.log += d));
  child.stderr.on('data', (d) => (wf.log += d));
  child.on('close', (code) => Object.assign(wf, { status: code === 0 ? 'finished' : 'failed', finished_at: now() }));
  return wf;
}
app.post('/api/v4/ai/duo_workflows/workflows', async (c) => {
  const b = await body(c);
  if (!b.project_id || !b.goal) return c.json({ message: 'project_id and goal are required' }, 400);
  const p = findProject(String(b.project_id));
  if (!p) return notFound(c, 'Project');
  const wf = b.start_workflow === false
    ? (S.workflows.push({ id: nextId(), project_id: p.id, goal: b.goal, source: 'rest', status: 'created', log: '', created_at: now() }), S.workflows.at(-1))
    : startWorkflow({ project_id: p.id, goal: String(b.goal), source: 'rest', consumer: b.ai_catalog_item_consumer_id });
  return c.json({ id: wf.id, project_id: wf.project_id, status: wf.status, goal: wf.goal }, 201);
});
app.get('/api/v4/ai/duo_workflows/workflows/:wid', (c) => {
  const wf = S.workflows.find((w) => w.id === Number(c.req.param('wid')));
  return wf ? c.json({ id: wf.id, project_id: wf.project_id, status: wf.status, goal: wf.goal }) : notFound(c, 'Workflow');
});

// OAuth 2 authorization code flow with PKCE (S256)
app.get('/oauth/authorize', (c) => {
  const q = c.req.query();
  if (q.response_type !== 'code' || !q.redirect_uri || !q.code_challenge) return c.text('invalid_request: response_type=code, redirect_uri and code_challenge are required', 400);
  const hidden = Object.entries(q).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
  return c.html(page('Authorize application', `
    <div class="card consent">
      <div class="avatar big">${initials(DEMO)}</div>
      <h1>Authorize <b>${esc(q.client_id ?? 'depmap-local')}</b> to use your account?</h1>
      <p>An application called <b>${esc(q.client_id ?? 'depmap-local')}</b> is requesting access to your GitLab account <b>@${DEMO.username}</b>.</p>
      <p>Authorize depmap-local to read your projects (<code>${esc(q.scope ?? 'read_api')}</code>):</p>
      <ul><li><b>read_api</b>: read-only access to projects, repository files and merge requests.</li></ul>
      <p class="muted">You will be redirected to <code>${esc(q.redirect_uri)}</code></p>
      <form method="post" action="/oauth/authorize">${hidden}
        <button name="decision" value="deny" class="btn">Deny</button>
        <button name="decision" value="authorize" class="btn primary">Authorize</button>
      </form>
    </div>`));
});
app.post('/oauth/authorize', async (c) => {
  const b: any = await c.req.parseBody();
  const target = new URL(String(b.redirect_uri));
  if (b.decision === 'authorize') {
    const code = randomBytes(20).toString('hex');
    S.codes.set(code, { challenge: String(b.code_challenge), redirectUri: String(b.redirect_uri), scope: String(b.scope ?? 'read_api') });
    target.searchParams.set('code', code);
  } else target.searchParams.set('error', 'access_denied');
  if (b.state) target.searchParams.set('state', String(b.state));
  return c.redirect(target.toString());
});
app.post('/oauth/token', async (c) => {
  const b = await body(c);
  const grant = S.codes.get(String(b.code));
  const fail = (d: string) => c.json({ error: 'invalid_grant', error_description: d }, 400);
  if (b.grant_type !== 'authorization_code' || !grant) return fail('The provided authorization grant is invalid or expired.');
  if (grant.redirectUri !== b.redirect_uri) return fail('redirect_uri does not match.');
  if (createHash('sha256').update(String(b.code_verifier ?? '')).digest('base64url') !== grant.challenge) return fail('PKCE verification failed.');
  S.codes.delete(String(b.code));
  const token = randomBytes(32).toString('hex');
  S.oauthTokens.add(token);
  return c.json({ access_token: token, token_type: 'Bearer', expires_in: 7200, refresh_token: randomBytes(32).toString('hex'), scope: grant.scope, created_at: Math.floor(Date.now() / 1000) });
});

// test helpers
app.post('/mock/jobs', async (c) => {
  const b = await c.req.json();
  const p = findProject(String(b.projectId ?? 1))!;
  const mr = S.mrs.find((m) => m.iid === Number(b.mrIid) && m.project_id === p.id);
  const job = {
    id: Number(b.jobId), name: b.name, stage: b.stage ?? 'depmap', status: b.status ?? 'success', ref: b.ref ?? mr?.source_branch ?? 'main', trace: String(b.trace ?? ''),
    pipeline: { id: Number(b.pipelineId), project_id: p.id, mr_iid: mr?.iid ?? null, sha: b.sha ?? mr?.sha, ref: b.ref ?? mr?.source_branch ?? 'main', source: mr ? 'merge_request_event' : 'push', web_url: `${p.web_url}/-/pipelines/${b.pipelineId}` },
    web_url: `${p.web_url}/-/jobs/${b.jobId}`, created_at: now(), finished_at: now(),
  };
  S.jobs.set(job.id, job);
  return c.json({ id: job.id }, 201);
});
app.get('/mock/calls', (c) => c.json(S.calls));
app.get('/mock/workflows', (c) => c.json(S.workflows));
app.post('/mock/reset', (c) => {
  S = fresh();
  return c.json({ ok: true });
});

// viewer: what a human sees on GitLab, minimal but faithful
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const initials = (u: User) => esc(u.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
const ago = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const labelPill = (l: string) => {
  const [scope, value] = l.includes('::') ? [l.slice(0, l.lastIndexOf('::')), l.slice(l.lastIndexOf('::') + 2)] : [l, null];
  const tone = /red/.test(l) ? 'red' : /amber/.test(l) ? 'amber' : /green/.test(l) ? 'green' : 'blue';
  return `<span class="label ${tone}"><span>${esc(scope)}</span>${value ? `<span>${esc(value)}</span>` : ''}</span>`;
};

function page(title: string, content: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · GitLab (local)</title>
<style>
:root{--bg:#fff;--fg:#28272d;--muted:#626168;--line:#dcdcde;--soft:#f6f6f8;--nav:#1f1e24;--link:#1f75cb;--accent:#7759c2;
--red:#c91c00;--red-bg:#fdd4cd;--amber:#9e5400;--amber-bg:#f5d9a8;--green:#217645;--green-bg:#c3e6cd;--blue:#1f75cb;--blue-bg:#cbe2f9}
@media (prefers-color-scheme:dark){:root{--bg:#18171d;--fg:#ececef;--muted:#a4a3a8;--line:#3a383f;--soft:#232128;--nav:#0f0e13;--link:#63a6e9;
--red:#fdbcb1;--red-bg:#8d1300;--amber:#f5d9a8;--amber-bg:#703800;--green:#91d4a8;--green-bg:#0a4020;--blue:#cbe2f9;--blue-bg:#0b5cad}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--nav);color:#fff;display:flex;align-items:center;gap:12px;padding:10px 16px}
header .logo{width:24px;height:24px;border-radius:6px;background:linear-gradient(135deg,#e24329,#fc6d26,#fca326)}header a{color:#fff;font-weight:600}
header .tag{margin-left:auto;font-size:12px;opacity:.7}
main{max-width:980px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 6px}h2{font-size:16px;margin:28px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.muted{color:var(--muted)}.card{border:1px solid var(--line);border-radius:8px;background:var(--bg)}
.row{display:flex;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.label{display:inline-flex;border-radius:12px;overflow:hidden;font-size:12px;line-height:20px;margin-right:4px;border:1px solid var(--line)}
.label span{padding:0 8px}.label span:first-child{background:var(--soft)}
.label.red span:last-child{background:var(--red-bg);color:var(--red)}.label.amber span:last-child{background:var(--amber-bg);color:var(--amber)}
.label.green span:last-child{background:var(--green-bg);color:var(--green)}.label.blue span:last-child{background:var(--blue-bg);color:var(--blue)}
.avatar{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;background:#e9e4f7;color:#5943b6}
.avatar.bot{background:#d8ebfb;color:#0b5cad}.avatar.big{width:56px;height:56px;font-size:18px;margin:0 auto 12px}
.note{display:flex;gap:12px;margin:16px 0}.note .card{flex:1;min-width:0}
.note-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;border-bottom:1px solid var(--line);background:var(--soft);border-radius:8px 8px 0 0}
.badge{font-size:11px;padding:0 8px;border-radius:10px;background:var(--blue-bg);color:var(--blue)}
.md{padding:4px 14px 12px;overflow-x:auto}.md img{max-width:100%;border:1px solid var(--line);border-radius:6px}
.md table{border-collapse:collapse;margin:8px 0;font-size:13px}.md th,.md td{border:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
.md code{background:var(--soft);padding:1px 4px;border-radius:4px;font-size:12.5px}.md pre{background:var(--soft);padding:10px;border-radius:6px;overflow-x:auto}.md pre code{padding:0}
textarea{width:100%;min-height:90px;font:inherit;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.btn{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
.btn.primary{background:#1f75cb;border-color:#1f75cb;color:#fff}
.consent{max-width:520px;margin:40px auto;padding:28px;text-align:left}.consent h1{text-align:center;font-size:19px}.consent form{display:flex;gap:8px;justify-content:flex-end;margin-top:20px}
pre.log{white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto;background:var(--soft);padding:10px;border-radius:6px;margin:0}
</style></head><body><header><span class="logo"></span><a href="/view">acme</a><span class="tag">local GitLab mock · ${esc(BASE)}</span></header><main>${content}</main></body></html>`;
}

// GitLab does not autolink pkg@version as an e-mail address
const md = (text: string) => marked.parse(text, { async: false }).replace(/<a href="mailto:[^"]*">([^<]*)<\/a>/g, '$1');
const noteHtml = (n: any) => `<div class="note" id="note_${n.id}"><div class="avatar ${n.author.bot ? 'bot' : ''}">${initials(n.author)}</div><div class="card">
  <div class="note-head"><b>${esc(n.author.name)}</b><span class="muted">@${esc(n.author.username)}</span>${n.author.bot ? '<span class="badge">service account</span>' : ''}
  <span class="muted">· ${ago(n.created_at)}${n.updated_at !== n.created_at ? ` · edited ${ago(n.updated_at)}` : ''}</span></div>
  <div class="md">${md(n.body)}</div></div></div>`;

app.get('/view', (c) => {
  const mrRow = (m: any) => `<div class="row"><a href="/view/${m.project_id}/mr/${m.iid}"><b>${esc(m.title)}</b></a><span class="muted">!${m.iid} · ${esc(m.source_branch)} → ${esc(m.target_branch)}</span>
    <span style="margin-left:auto">${m.labels.filter((l: string) => l.startsWith('depmap::')).map(labelPill).join('')}</span><span class="muted">${S.notes.filter((n) => n.noteable_type === 'MergeRequest' && n.noteable_iid === m.iid).length} notes</span></div>`;
  const issueRow = (i: any) => `<div class="row"><a href="/view/${i.project_id}/issues/${i.iid}"><b>${esc(i.title)}</b></a><span class="muted">#${i.iid} · ${esc(S.projects.find((p) => p.id === i.project_id)?.path_with_namespace)}</span><span style="margin-left:auto">${i.labels.map(labelPill).join('')}</span></div>`;
  const wfRow = (w: any) => `<div class="row" style="display:block"><b>Workflow ${w.id}</b> <span class="muted">· ${esc(w.source)} · ${esc(w.status)} · ${ago(w.created_at)}</span><pre class="log">${esc(w.goal)}\n\n${esc(w.log)}</pre></div>`;
  return c.html(page('acme', `<h1>acme</h1><p class="muted">Projects: ${S.projects.map((p) => `<a href="${p.web_url}">${esc(p.path_with_namespace)}</a>`).join(' · ')}</p>
    <h2>Merge requests · acme/shop</h2><div class="card">${S.mrs.map(mrRow).join('')}</div>
    <h2>Issues</h2><div class="card">${S.issues.map(issueRow).join('') || '<div class="row muted">No issues yet.</div>'}</div>
    <h2>Duo workflows</h2><div class="card">${S.workflows.map(wfRow).join('') || '<div class="row muted">No workflows yet.</div>'}</div>`));
});

app.get('/view/:pid/mr/:iid', (c) => {
  const mr = S.mrs.find((m) => m.project_id === Number(c.req.param('pid')) && m.iid === Number(c.req.param('iid')));
  if (!mr) return c.text('Not found', 404);
  const notes = S.notes.filter((n) => n.noteable_type === 'MergeRequest' && n.noteable_iid === mr.iid && n.project_id === mr.project_id);
  return c.html(page(mr.title, `<p class="muted"><a href="/view">acme / shop</a> › Merge requests › !${mr.iid}</p><h1>${esc(mr.title)}</h1>
    <p><span class="badge">Open</span> <b>${esc(mr.author.name)}</b> requested to merge <code>${esc(mr.source_branch)}</code> into <code>${esc(mr.target_branch)}</code> ${mr.labels.map(labelPill).join('')}</p>
    <h2>Activity</h2>${notes.map(noteHtml).join('') || '<p class="muted">No comments yet.</p>'}
    <form method="post" action="/view/${mr.project_id}/mr/${mr.iid}/notes" class="note"><div class="avatar">${initials(DEMO)}</div><div style="flex:1">
      <textarea name="body" placeholder="Comment as @demo. Try: /depmap accept chalk@5.6.1 1d: reason, or mention @depmap"></textarea>
      <p><button class="btn primary">Comment</button></p></div></form>`));
});
app.post('/view/:pid/mr/:iid/notes', async (c) => {
  const b: any = await c.req.parseBody();
  if (String(b.body ?? '').trim()) addNote(Number(c.req.param('pid')), 'MergeRequest', Number(c.req.param('iid')), String(b.body), DEMO);
  return c.redirect(`/view/${c.req.param('pid')}/mr/${c.req.param('iid')}`);
});
app.get('/view/:pid/issues/:iid', (c) => {
  const issue = S.issues.find((i) => i.project_id === Number(c.req.param('pid')) && i.iid === Number(c.req.param('iid')));
  if (!issue) return c.text('Not found', 404);
  const notes = S.notes.filter((n) => n.noteable_type === 'Issue' && n.noteable_iid === issue.iid && n.project_id === issue.project_id);
  return c.html(page(issue.title, `<p class="muted"><a href="/view">acme</a> › Issues › #${issue.iid}</p><h1>${esc(issue.title)}</h1><p>${issue.labels.map(labelPill).join('')}</p>
    ${noteHtml({ ...issue, body: issue.description })}${notes.map(noteHtml).join('')}`));
});
app.get('/:ns/:project', (c) => {
  const p = findProject(`${c.req.param('ns')}/${c.req.param('project')}`);
  return p ? c.redirect('/view') : c.text('Not found', 404);
});

if (import.meta.main) serve({ fetch: app.fetch, port: PORT }, () => console.log(`mock GitLab on ${BASE} (viewer: ${BASE}/view)`));
