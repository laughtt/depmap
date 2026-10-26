// The complete pipeline on a real GitLab CE + runner in Docker (compose profile `gitlab`), against the depmap API on :8787.
// Idempotent: reuses GitLab, the runner and the projects; each run closes the old MRs and opens fresh ones.
// Usage: node scripts/local-gitlab.mjs        GitLab: http://localhost:8090 (root / $GITLAB_ROOT_PASSWORD)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = new URL('..', import.meta.url).pathname;
const GL = 'http://localhost:8090';
const API = 'http://localhost:8787';
const HOST_API = 'http://host.docker.internal:8787'; // the depmap API as a job container sees it
const STATE = join(APP, 'fixtures/local/gitlab.json'); // git-ignored: tokens of this local instance
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

async function gl(path, { method = 'GET', body, token = state.root } = {}) {
  const res = await fetch(`${GL}/api/v4${path}`, {
    method, headers: { 'private-token': token, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 200)}`), { status: res.status });
  return text ? JSON.parse(text) : null;
}
const until = async (what, fn, ms = 600_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(3000)) {
    const v = await fn().catch(() => null);
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
};

console.log('starting GitLab CE + runner (the first boot takes ~5 minutes)');
sh('docker', ['compose', '--profile', 'gitlab', 'up', '-d', 'gitlab', 'gitlab-runner'], { stdio: 'inherit' });
if (!(await fetch(`${API}/api/health`).then((r) => r.ok, () => false))) throw new Error('start the depmap API first: scripts/demo.sh --keep-data');
await until('GitLab', () => fetch(`${GL}/users/sign_in`).then((r) => r.ok), 1_200_000);

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
if (!state.root || !(await gl('/user').catch(() => null))) {
  console.log('creating a root token (gitlab-rails runner, ~1 minute)');
  state.root = `glpat-depmap-root-${Date.now()}`;
  sh('docker', ['compose', 'exec', '-T', 'gitlab', 'gitlab-rails', 'runner',
    `t = User.find_by_username('root').personal_access_tokens.create!(name: 'depmap-local', scopes: [:api, :sudo, :admin_mode], expires_at: 300.days.from_now); t.set_token('${state.root}'); t.save!`]);
}
// the remote include and the jobs talk to host.docker.internal, a private address GitLab blocks by default
await gl('/application/settings', { method: 'PUT', body: { allow_local_requests_from_web_hooks_and_services: true, auto_devops_enabled: false, signup_enabled: false } });

const runnerConfig = () => { try { return sh('docker', ['compose', 'exec', '-T', 'gitlab-runner', 'cat', '/etc/gitlab-runner/config.toml']); } catch { return ''; } };
if (!runnerConfig().includes('[[runners]]')) {
  const { token } = await gl('/user/runners', { method: 'POST', body: { runner_type: 'instance_type', run_untagged: true, description: 'local docker' } });
  const network = sh('docker', ['inspect', '-f', '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}', sh('docker', ['compose', 'ps', '-q', 'gitlab']).trim()]).trim();
  sh('docker', ['compose', 'exec', '-T', 'gitlab-runner', 'gitlab-runner', 'register', '--non-interactive', '--url', 'http://gitlab:8090', '--token', token,
    '--executor', 'docker', '--docker-image', 'node:22', '--docker-network-mode', network, '--docker-pull-policy', 'if-not-present', '--clone-url', 'http://gitlab:8090']);
  console.log(`registered the runner on network ${network}`);
}

// a bot user posts the reports, so human `/depmap accept` notes (by root) are told apart from depmap's own
let [bot] = await gl('/users?username=depmap-bot');
bot ??= await gl('/users', { method: 'POST', body: { username: 'depmap-bot', name: 'depmap bot', email: 'depmap-bot@depmap.local', password: `Bot-${Date.now()}-pw!`, skip_confirmation: true } });
if (!state.bot || !(await gl('/user', { token: state.bot }).catch(() => null))) {
  state.bot = (await gl(`/users/${bot.id}/personal_access_tokens`, { method: 'POST', body: { name: 'depmap-ci', scopes: ['api'], expires_at: new Date(Date.now() + 300 * 864e5).toISOString().slice(0, 10) } })).token;
}
writeFileSync(STATE, JSON.stringify(state, null, 2));

const group = (await gl('/groups?search=demo')).find((g) => g.full_path === 'demo') ?? (await gl('/groups', { method: 'POST', body: { name: 'demo', path: 'demo', visibility: 'public' } }));
await gl(`/groups/${group.id}/members`, { method: 'POST', body: { user_id: bot.id, access_level: 40 } }).catch((e) => e.status === 409 || Promise.reject(e));
const vars = {
  DEPMAP_API_URL: HOST_API, DEPMAP_RENDER_URL: HOST_API, DEPMAP_APP_URL: API, GITLAB_URL: 'http://gitlab:8090', GITLAB_TOKEN: state.bot, DEPMAP_START_FLOW: '1',
};
for (const [key, value] of Object.entries(vars)) {
  const body = { key, value, masked: key === 'GITLAB_TOKEN' };
  await gl(`/groups/${group.id}/variables/${key}`, { method: 'PUT', body }).catch(() => gl(`/groups/${group.id}/variables`, { method: 'POST', body }));
}

async function project(name) {
  const p = await gl(`/projects/${encodeURIComponent(`demo/${name}`)}`).catch(() => null);
  // re-runs force-push the demo history, so main stays protected but allows it
  if (p) await gl(`/projects/${p.id}/protected_branches/main`, { method: 'PATCH', body: { allow_force_push: true } }).catch(() => {});
  return p ?? gl('/projects', { method: 'POST', body: { name, path: name, namespace_id: group.id, visibility: 'public', initialize_with_readme: false } });
}
const asOf = (p, value) => gl(`/projects/${p.id}/variables/DEPMAP_AS_OF`, { method: 'PUT', body: { value } })
  .catch(() => gl(`/projects/${p.id}/variables`, { method: 'POST', body: { key: 'DEPMAP_AS_OF', value } }));

// each project includes the template from the depmap server, exactly as any GitLab project would
const work = mkdtempSync(join(tmpdir(), 'depmap-gitlab-'));
function push(name, main, branches = {}) {
  const dir = join(work, name);
  const git = (...args) => sh('git', ['-c', 'user.email=dev@depmap.local', '-c', 'user.name=demo dev', ...args], { cwd: dir });
  sh('rm', ['-rf', dir]);
  cpSync(join(APP, 'demo', main), dir, { recursive: true });
  writeFileSync(join(dir, '.gitlab-ci.yml'), `include:\n  - remote: ${HOST_API}/ci/templates/depmap.gitlab-ci.yml\n`);
  sh('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  git('add', '-A');
  git('commit', '-qm', 'Initial commit');
  const head = git('rev-parse', 'HEAD').trim();
  const shas = { main: head };
  for (const [branch, src] of Object.entries(branches)) {
    const tmp = `${dir}-${branch}`;
    cpSync(join(APP, 'demo', src), tmp, { recursive: true });
    git('checkout', '-q', '-B', branch, head);
    sh('rsync', ['-a', '--delete', '--exclude', '.git', '--exclude', '.gitlab-ci.yml', `${tmp}/`, `${dir}/`]);
    git('add', '-A');
    git('commit', '-qm', `Update dependencies (${branch})`);
    shas[branch] = git('rev-parse', 'HEAD').trim();
  }
  git('push', '-q', '-f', '-o', 'ci.skip', `http://root:${state.root}@localhost:8090/demo/${name}.git`, ...Object.keys(shas).map((b) => `${b}:${b}`));
  return shas;
}

async function finished(p, pipeline) {
  const done = await until(`pipeline ${pipeline.id}`, async () => {
    const pl = await gl(`/projects/${p.id}/pipelines/${pipeline.id}`);
    return ['success', 'failed', 'canceled'].includes(pl.status) && pl;
  });
  const jobs = await gl(`/projects/${p.id}/pipelines/${pipeline.id}/jobs`);
  const trace = (job) => fetch(`${GL}/api/v4/projects/${p.id}/jobs/${jobs.find((j) => j.name === job)?.id}/trace`, { headers: { 'private-token': state.root } }).then((res) => res.text());
  console.log(`   pipeline ${GL}/demo/${p.path}/-/pipelines/${done.id}: ${done.status} · ${jobs.map((j) => `${j.name} ${j.status}`).join(', ')}`);
  return { ...done, jobs, trace };
}
const mainPipeline = async (p, when) => {
  await asOf(p, when);
  return finished(p, await gl(`/projects/${p.id}/pipeline`, { method: 'POST', body: { ref: 'main' } }));
};
const mrPipeline = async (p, mr, when) => {
  await asOf(p, when);
  return finished(p, await gl(`/projects/${p.id}/merge_requests/${mr.iid}/pipelines`, { method: 'POST' }));
};
async function openMr(p, branch, title, when) {
  for (const old of await gl(`/projects/${p.id}/merge_requests?state=opened&source_branch=${branch}`)) await gl(`/projects/${p.id}/merge_requests/${old.iid}`, { method: 'PUT', body: { state_event: 'close' } });
  await asOf(p, when);
  const mr = await gl(`/projects/${p.id}/merge_requests`, { method: 'POST', body: { source_branch: branch, target_branch: 'main', title } });
  // creating the MR starts its pipeline
  const pipeline = await until(`MR !${mr.iid} pipeline`, async () => (await gl(`/projects/${p.id}/merge_requests/${mr.iid}/pipelines`))[0]);
  return { mr, run: await finished(p, pipeline) };
}
const reports = async (p, mr) => (await gl(`/projects/${p.id}/merge_requests/${mr.iid}/notes?sort=asc&per_page=100`)).filter((n) => n.body.includes('<!-- depmap:report -->'));

// earlier runs' decisions would let the replay pass on the first try
const { q, pool } = await import(join(APP, 'server/src/db/db.ts'));
await q("delete from decision where repo like 'demo/%'");
await pool.end();

const shop = await project('shop');
const admin = await project('admin');
push('shop', 'shop', { 'chalk-5': 'scenarios/a-chalk5', 'debug-4.3.7': 'scenarios/b-debug-patch', 'deps-sept-8': 'scenarios/d-replay-2025-09-08' });
push('admin', 'admin');
console.log(`pushed demo/shop and demo/admin to ${GL}`);

console.log('\n== demo/shop main');
const m = await mainPipeline(shop, '2025-08-01T10:00:00Z');
check('main: scan + gate pass on the default branch', m.status === 'success' && (await m.trace('depmap:scan')).includes('END_DEPMAP_JSON'));
console.log('\n== demo/admin main');
check('admin: main pipeline passes', (await mainPipeline(admin, '2025-09-01T10:00:00Z')).status === 'success');

console.log('\n== MR chalk 4 → 5');
const a = await openMr(shop, 'chalk-5', 'Upgrade chalk to 5', '2025-08-20T09:00:00Z');
const [noteA] = await reports(shop, a.mr);
check('chalk 5 MR: pipeline passes', a.run.status === 'success');
check('chalk 5 MR: one report note by depmap-bot with NEEDS_CHANGE at src/log.js:1', noteA?.author.username === 'depmap-bot' && noteA.body.includes('`NEEDS_CHANGE`') && noteA.body.includes('`src/log.js:1`'));
check('chalk 5 MR: the note embeds the map PNG uploaded to GitLab', /!\[depmap\]\(\/uploads\/\w+\/depmap\.png\)/.test(noteA?.body ?? ''));
const [status] = await gl(`/projects/${shop.id}/repository/commits/${a.mr.sha}/statuses?name=depmap`);
check('chalk 5 MR: a depmap commit status links the commit to its page', status?.status === 'success' && /\/repos\/demo\/shop\/scans\/\d+$/.test(status.target_url ?? ''), status?.target_url);
check('chalk 5 MR: label depmap::amber', (await gl(`/projects/${shop.id}/merge_requests/${a.mr.iid}`)).labels.includes('depmap::amber'));

console.log('\n== MR debug patch');
const b = await openMr(shop, 'debug-4.3.7', 'Bump debug to 4.3.7', '2025-08-22T09:00:00Z');
check('debug patch MR: passes with NO_CHANGE', b.run.status === 'success' && (await reports(shop, b.mr))[0]?.body.includes('`NO_CHANGE`'));

console.log('\n== MR Sept 8, 2025 replay @13:30 UTC');
const d = await openMr(shop, 'deps-sept-8', 'Routine dependency refresh', '2025-09-08T13:30:00Z');
const gate = await d.run.trace('depmap:gate');
check('replay MR @13:30: pipeline FAILS at depmap:gate on chalk@5.6.1 and debug@4.4.2', d.run.status === 'failed' && d.run.jobs.find((j) => j.name === 'depmap:gate')?.status === 'failed' && gate.includes('chalk@5.6.1') && gate.includes('debug@4.4.2'));
check('replay MR @13:30: report still posted (when: always), label depmap::red', (await reports(shop, d.mr)).length === 1 && (await gl(`/projects/${shop.id}/merge_requests/${d.mr.iid}`)).labels.includes('depmap::red'));
const [blocked] = await gl(`/projects/${shop.id}/repository/commits/${d.mr.sha}/statuses?name=depmap`);
check('replay MR @13:30: the depmap commit status is failed', blocked?.status === 'failed', blocked?.description);
check('replay MR: no Duo on CE, the flow start is reported, not fatal', /Duo flow not started|started Duo flow/.test(await d.run.trace('depmap:report')));

console.log('\n== same MR @18:00 UTC: the OSV MAL- records are public now');
const d2 = await mrPipeline(shop, d.mr, '2025-09-08T18:00:00Z');
const [noteD] = await reports(shop, d.mr);
check('replay MR @18:00: still fails; note shows MAL- links and the 4/4 fingerprint', d2.status === 'failed' && /osv\.dev\/vulnerability\/MAL-/.test(noteD?.body ?? '') && /4 of 4 signals/.test(noteD?.body ?? ''));

console.log('\n== a human accepts both in the MR thread, then re-runs');
for (const pv of ['chalk@5.6.1', 'debug@4.4.2']) await gl(`/projects/${shop.id}/merge_requests/${d.mr.iid}/notes`, { method: 'POST', body: { body: `/depmap accept ${pv} 1d: replay demo, pinned in the next MR` } });
const d3 = await mrPipeline(shop, d.mr, '2025-09-08T18:00:00Z');
const after = await reports(shop, d.mr);
check('replay MR after accept: pipeline passes', d3.status === 'success' && /applied \/depmap accept chalk@5\.6\.1/.test(await d3.trace('depmap:scan')));
check('replay MR: the same report note was updated in place', after.length === 1 && after[0].id === noteD?.id && after[0].body.includes('accepted by @root'));

console.log('\n== scheduled refresh (demo/admin): the world changes, no commit');
await gl(`/projects/${admin.id}/variables/DEPMAP_AS_OF`, { method: 'DELETE' }).catch(() => {});
const schedules = await gl(`/projects/${admin.id}/pipeline_schedules`);
const schedule = schedules.find((s) => s.description === 'depmap refresh') ??
  (await gl(`/projects/${admin.id}/pipeline_schedules`, { method: 'POST', body: { description: 'depmap refresh', ref: 'main', cron: '0 * * * *', active: true } }));
const before = (await gl(`/projects/${admin.id}/pipelines?source=schedule`))[0]?.id ?? 0;
await gl(`/projects/${admin.id}/pipeline_schedules/${schedule.id}/play`, { method: 'POST' });
const r = await finished(admin, await until('the refresh pipeline', async () => (await gl(`/projects/${admin.id}/pipelines?source=schedule`)).find((pl) => pl.id > before)));
const issues = async (p) => (await gl(`/projects/${p.id}/issues?labels=security::watch&state=opened`)).map((i) => i.title);
check('refresh: only depmap:refresh runs on the schedule, and it passes', r.status === 'success' && r.jobs.map((j) => j.name).join() === 'depmap:refresh');
check('refresh: security::watch issue for ms@2.1.2 in demo/shop and demo/admin', (await issues(shop)).includes('depmap: ms@2.1.2 turned red') && (await issues(admin)).includes('depmap: ms@2.1.2 turned red'), (await issues(shop)).join('; '));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · GitLab ${GL}/demo (root / $GITLAB_ROOT_PASSWORD) · map ${API}`);
process.exit(failed.length ? 1 : 0);
