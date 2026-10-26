// GitLab E2E, fully local: mock GitLab + the depmap API + the CI template run by gitlab-ci-local on temp git repos.
// Usage: node scripts/e2e-gitlab.mjs [--keep]   (--keep leaves a mock it started running, so /view stays browsable)
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = new URL('..', import.meta.url).pathname;
const MOCK = `http://localhost:${process.env.MOCK_GITLAB_PORT ?? 8929}`;
const API = process.env.DEPMAP_API_URL ?? 'http://localhost:8787';
const GLCI = join(APP, 'node_modules/.bin/gitlab-ci-local');
const TOKEN = 'glpat-demo';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const runs = [];
const children = [];

const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const up = (url) => fetch(url).then((r) => r.ok, () => false);
async function ensure(url, args, env = {}) {
  if (await up(url)) return 'already running';
  const child = spawn(process.execPath, args, { cwd: APP, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  children.push(child);
  for (let i = 0; i < 75; i++) {
    await sleep(200);
    if (await up(url)) return 'started';
  }
  throw new Error(`could not start ${args.join(' ')}`);
}
async function gl(path, init = {}) {
  const res = await fetch(`${MOCK}/api/v4${path}`, { ...init, headers: { 'private-token': TOKEN, 'content-type': 'application/json' } });
  return res.json();
}

console.log(`mock GitLab: ${await ensure(`${MOCK}/mock/workflows`, ['server/src/gitlab/mock.ts'])}`);
console.log(`depmap API: ${await ensure(`${API}/api/health`, ['server/src/api/main.ts'], { DATA_MODE: 'replay', ADVISORY_FEED: 'fixtures/feed/simulated-advisory.json' })}`);
await fetch(`${MOCK}/mock/reset`, { method: 'POST' });

// decisions from earlier runs would make the replay gate pass on the first try; the API has no delete endpoint, so use the DB
const { q, pool } = await import(join(APP, 'server/src/db/db.ts'));
await q("delete from decision where repo = 'acme/shop' and reason like 'replay demo%'");
await q("delete from event where kind = 'decision' and repo = 'acme/shop' and payload->>'reason' like 'replay demo%'");
await pool.end();

const work = mkdtempSync(join(tmpdir(), 'depmap-e2e-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=e2e@depmap.local', '-c', 'user.name=depmap e2e', ...args], { cwd, stdio: 'pipe' });
function makeRepo(name, main, branches = {}) {
  const dir = join(work, name);
  mkdirSync(join(dir, '.gitlab'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', `git@gitlab.local:acme/${name}.git`);
  writeFileSync(join(dir, '.gitlab-ci.yml'), 'include:\n  - local: .gitlab/depmap.gitlab-ci.yml\n');
  cpSync(join(APP, 'ci/templates/depmap.gitlab-ci.yml'), join(dir, '.gitlab/depmap.gitlab-ci.yml'));
  writeFileSync(join(dir, '.gitignore'), 'depmap.json\ndepmap.png\ngl-sbom-*.json\n.gitlab-ci-local/\n');
  const load = (src, msg) => {
    for (const f of readdirSync(dir)) if (!f.startsWith('.')) rmSync(join(dir, f), { recursive: true });
    cpSync(join(APP, 'demo', src), dir, { recursive: true });
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', msg);
  };
  load(main, 'main');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  for (const [branch, src] of Object.entries(branches)) {
    git(dir, 'checkout', '-q', '-b', branch, 'main');
    load(src, branch);
  }
  git(dir, 'checkout', '-q', 'main');
  return dir;
}

// gitlab-ci-local copies artifacts with `shopt -s globstar` (bash 4+); macOS ships bash 3.2, so shim it for paths without **
const shimDir = join(work, 'bin');
const PATH = /version [4-9]/.test(spawnSync('bash', ['--version'], { encoding: 'utf8' }).stdout) ? process.env.PATH : `${shimDir}:${process.env.PATH}`;
mkdirSync(shimDir);
writeFileSync(join(shimDir, 'bash'), '#!/bin/bash\nargs=()\nfor a in "$@"; do args+=("${a//shopt -s globstar /shopt -s }"); done\nexec /bin/bash "${args[@]}"\n', { mode: 0o755 });

let pipelineSeq = 5000;
let jobSeq = 70000;
function pipeline(label, dir, branch, vars) {
  git(dir, 'checkout', '-q', branch);
  rmSync(join(dir, 'depmap.json'), { force: true });
  const all = {
    DEPMAP_API_URL: API, DEPMAP_APP_URL: API, GITLAB_URL: MOCK, GITLAB_TOKEN: TOKEN, GITLAB_MOCK_JOBS: '1',
    DEPMAP_CI_DIR: join(APP, 'ci'), PLAYWRIGHT_CORE_PATH: join(APP, 'server/node_modules/playwright-core/index.mjs'), CI_DEFAULT_BRANCH: 'main', ...vars,
  };
  const r = spawnSync(GLCI, ['--force-shell-executor', '--ignore-predefined-vars', Object.keys(all).filter((k) => k.startsWith('CI_')).join(','),
    ...Object.entries(all).flatMap(([k, v]) => ['--variable', `${k}=${v}`])], { cwd: dir, encoding: 'utf8', timeout: 300_000, env: { ...process.env, PATH } });
  let out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  let mode = 'gitlab-ci-local';
  let gate = /PASS\s+depmap:gate/.test(out) ? 'pass' : /FAIL\s+depmap:gate/.test(out) ? 'fail' : null;
  if (!existsSync(join(dir, 'depmap.json')) || !gate) {
    // fallback: the same scripts, the same variables, run in job order
    mode = `direct (gitlab-ci-local unusable: ${r.error?.message ?? out.trim().split('\n').at(-1)})`;
    const env = { ...process.env, ...all, CI_PIPELINE_ID: String(++pipelineSeq), CI_COMMIT_REF_NAME: branch };
    const job = (name, script) => spawnSync(process.execPath, [join(APP, 'ci', script)], { cwd: dir, encoding: 'utf8', env: { ...env, CI_JOB_NAME: name, CI_JOB_ID: String(++jobSeq) } });
    const steps = [['depmap:scan', 'depmap-scan.mjs'], ['depmap:scan', 'depmap-sbom.mjs'], ['depmap:gate', 'depmap-gate.mjs'],
      ...(vars.CI_MERGE_REQUEST_IID ? [['depmap:report', 'depmap-render.mjs'], ['depmap:report', 'depmap-post.mjs']] : [])];
    out = '';
    for (const [name, script] of steps) {
      const s = job(name, script);
      out += `${name} ${script} exit ${s.status}\n${s.stdout}${s.stderr}`;
      if (script === 'depmap-gate.mjs') gate = s.status === 0 ? 'pass' : 'fail';
    }
  }
  const result = existsSync(join(dir, 'depmap.json')) ? JSON.parse(readFileSync(join(dir, 'depmap.json'), 'utf8')) : null;
  runs.push({ label, mode, gate, snapshotId: result?.snapshotId ?? null });
  console.log(`\n== ${label}: ${mode}, gate ${gate}, snapshot ${result?.snapshotId}`);
  writeFileSync(join(work, `${label.replace(/\W+/g, '-')}.log`), out);
  return { out, gate, result, mode };
}

const report = async (iid) => (await gl(`/projects/1/merge_requests/${iid}/notes?sort=asc`)).filter((n) => n.body.includes('<!-- depmap:report -->'));
async function waitWorkflows(n) {
  for (let i = 0; i < 100; i++) {
    const wfs = await (await fetch(`${MOCK}/mock/workflows`)).json();
    if (wfs.length >= n && wfs.every((w) => w.status !== 'running')) return wfs;
    await sleep(200);
  }
  return (await fetch(`${MOCK}/mock/workflows`)).json();
}

const shopMain = (await gl('/projects/1/repository/commits/main')).id;
const shop = makeRepo('shop', 'shop', { 'chalk-5': 'scenarios/a-chalk5', 'debug-4.3.7': 'scenarios/b-debug-patch', 'deps-sept-8': 'scenarios/d-replay-2025-09-08' });
const admin = makeRepo('admin', 'admin');
const shopVars = { CI_PROJECT_PATH: 'acme/shop', CI_PROJECT_ID: '1' };
const mrVars = async (iid, asOf, extra = {}) => {
  const mr = await gl(`/projects/1/merge_requests/${iid}`);
  return { ...shopVars, CI_PIPELINE_SOURCE: 'merge_request_event', CI_MERGE_REQUEST_IID: String(iid), CI_MERGE_REQUEST_SOURCE_BRANCH_NAME: mr.source_branch,
    CI_MERGE_REQUEST_DIFF_BASE_SHA: mr.diff_refs.base_sha, CI_COMMIT_SHA: mr.sha, DEPMAP_AS_OF: asOf, ...extra };
};

// default-branch pipelines first: they create the base snapshots the MR deltas compare against
const main = pipeline('acme/shop main', shop, 'main', { ...shopVars, CI_PIPELINE_SOURCE: 'push', CI_COMMIT_SHA: shopMain, DEPMAP_AS_OF: '2025-08-01T10:00:00Z' });
check('main: default-branch pipeline scans and passes the gate', main.gate === 'pass' && main.result?.gate.pass);
const adminRun = pipeline('acme/admin main', admin, 'main', { CI_PROJECT_PATH: 'acme/admin', CI_PROJECT_ID: '2', CI_PIPELINE_SOURCE: 'push',
  CI_COMMIT_SHA: (await gl('/projects/2/repository/commits/main')).id, DEPMAP_AS_OF: '2025-09-01T10:00:00Z' });
check('admin: default-branch pipeline scans', adminRun.result?.snapshotId > 0);

const mr1 = pipeline('MR !1 chalk 4→5', shop, 'chalk-5', await mrVars(1, '2025-08-20T09:00:00Z'));
const [note1] = await report(1);
check('MR !1: gate passes', mr1.gate === 'pass');
check('MR !1: note has Upgrade impact NEEDS_CHANGE at src/log.js:1', note1?.body.includes('#### Upgrade impact') && note1.body.includes('`NEEDS_CHANGE`') && note1.body.includes('`src/log.js:1`'));
check('MR !1: note embeds the uploaded map PNG', /!\[depmap\]\(\/uploads\/\w+\/depmap\.png\)/.test(note1?.body ?? ''), 'needs Chrome');
const statuses = await (await fetch(`${MOCK}/mock/statuses`)).json();
check('every pipeline sets a depmap commit status linking to its page', statuses.length >= 3 && statuses.every((st) => st.name === 'depmap' && /\/#\/c\/acme\/(shop|admin)\/\d+$/.test(st.target_url)), `${statuses.length} statuses`);
check('MR !1: label depmap::amber', (await gl('/projects/1/merge_requests/1')).labels.includes('depmap::amber'));

const mr2 = pipeline('MR !2 debug patch', shop, 'debug-4.3.7', await mrVars(2, '2025-08-22T09:00:00Z'));
const [note2] = await report(2);
check('MR !2: gate passes', mr2.gate === 'pass');
check('MR !2: note has NO_CHANGE', note2?.body.includes('`NO_CHANGE`'));

const replay = (asOf) => mrVars(4, asOf, { DEPMAP_START_FLOW: '1' });
const mr4 = pipeline('MR !4 replay 2025-09-08 13:30', shop, 'deps-sept-8', await replay('2025-09-08T13:30:00Z'));
const reds = mr4.result?.gate.undecidedReds ?? [];
check('MR !4 @13:30: gate FAILS on chalk@5.6.1 and debug@4.4.2', mr4.gate === 'fail' && reds.includes('chalk@5.6.1') && reds.includes('debug@4.4.2'), reds.join(', '));
const [note4] = await report(4);
check('MR !4 @13:30: note lists red packages with reasons and links', note4?.body.includes('#### Red packages') && /\*\*`chalk@5\.6\.1`\*\*: \*\*needs a decision\*\*/.test(note4.body) && /\]\(https?:\/\//.test(note4.body));
check('MR !4 @13:30: label depmap::red', (await gl('/projects/1/merge_requests/4')).labels.includes('depmap::red'));
const [restFlow] = await waitWorkflows(1);
check('MR !4 @13:30: flow started over REST (goal names pipeline and job) and finished', restFlow?.source === 'rest' && restFlow.status === 'finished' && /Pipeline \d+, job \d+/.test(restFlow.goal), restFlow?.status);
const flowNotes = () => gl('/projects/1/merge_requests/4/notes?sort=asc').then((ns) => ns.filter((n) => n.author.username === 'ai-depmap-acme'));
const investigation = (await flowNotes()).find((n) => n.body.includes('depmap investigation'));
check('MR !4 @13:30: investigation note posted by ai-depmap-acme', investigation && investigation.body.includes('chalk@5.6.1') && investigation.body.includes('debug@4.4.2') && investigation.body.includes('/depmap pin chalk@4.1.2'));

// 18:00: the OSV MAL- records are public now; same commit, new risk
const replayVars = await replay('2025-09-08T18:00:00Z');
const mr4m = pipeline('MR !4 replay 2025-09-08 18:00', shop, 'deps-sept-8', replayVars);
const notes4m = await report(4);
const fp = notes4m[0]?.body.match(/Looks like \*\*[^*]+\*\*: \d of \d signals/)?.[0];
check('MR !4 @18:00: gate still fails; note shows MAL- reasons and the fingerprint', mr4m.gate === 'fail' && /\[malicious\]\(https:\/\/osv\.dev\/vulnerability\/MAL-/.test(notes4m[0]?.body ?? '') && /chalk\/debug[^*]*\*\*: 4 of 4 signals/.test(fp ?? ''), fp);
await waitWorkflows(2);
check('MR !4 @18:00: the new investigation explains the fingerprint', (await flowNotes()).some((n) => n.body.includes('depmap investigation') && /matches 4 of 4 signals of \*chalk\/debug/.test(n.body)));

await gl('/projects/1/merge_requests/4/notes', { method: 'POST', body: JSON.stringify({ body: '/depmap accept chalk@5.6.1 1d: replay demo' }) });
await gl('/projects/1/merge_requests/4/notes', { method: 'POST', body: JSON.stringify({ body: '@depmap /depmap accept debug@4.4.2 1d: replay demo' }) });
const wfs = await waitWorkflows(3);
const mention = wfs.find((w) => w.source === 'mention');
check('MR !4: @depmap mention starts the flow, which explains the decision', mention?.status === 'finished' && (await flowNotes()).some((n) => n.body.includes('What your comment will do') && n.body.includes('debug@4.4.2')));

const mr4b = pipeline('MR !4 replay 2025-09-08 18:00 (after accept)', shop, 'deps-sept-8', replayVars);
const notes4 = await report(4);
check('MR !4: re-run applies both decisions and passes the gate', mr4b.gate === 'pass' && /applied \/depmap accept chalk@5\.6\.1/.test(mr4b.out) && /applied \/depmap accept debug@4\.4\.2/.test(mr4b.out));
check('MR !4: the same note is updated, not duplicated', notes4.length === 1 && notes4[0].id === note4?.id && notes4[0].updated_at !== notes4[0].created_at && notes4[0].body.includes('accepted by @demo'), `${notes4.length} report note(s)`);
check('MR !4: label moves to depmap::amber', (await gl('/projects/1/merge_requests/4')).labels.filter((l) => l.startsWith('depmap::')).join() === 'depmap::amber');

const refreshEnv = { ...process.env, DEPMAP_API_URL: API, GITLAB_URL: MOCK, GITLAB_TOKEN: TOKEN };
const refresh = spawnSync(process.execPath, [join(APP, 'ci/depmap-refresh.mjs')], { cwd: APP, encoding: 'utf8', env: refreshEnv });
console.log(`\n== refresh (direct; a scheduled pipeline job)\n${refresh.stdout}${refresh.stderr}`);
runs.push({ label: 'scheduled refresh', mode: 'direct (scheduled job, not part of the MR template)', gate: null });
const msIssues = async (pid) => (await gl(`/projects/${pid}/issues?labels=security::watch`)).filter((i) => i.title === 'depmap: ms@2.1.2 turned red');
const [shopIssues, adminIssues] = [await msIssues(1), await msIssues(2)];
check('refresh: opens a security::watch issue for ms@2.1.2 in acme/shop and acme/admin', refresh.status === 0 && shopIssues.length === 1 && adminIssues.length === 1 && /Fixed in 2\.1\.3|\*\*2\.1\.3\*\*/.test(shopIssues[0].description));
spawnSync(process.execPath, [join(APP, 'ci/depmap-refresh.mjs')], { cwd: APP, encoding: 'utf8', env: refreshEnv });
check('refresh: a second run does not duplicate issues', (await msIssues(1)).length === 1 && (await msIssues(2)).length === 1);

const calls = await (await fetch(`${MOCK}/mock/calls`)).json();
check('mock saw no unauthorized or failed API calls', !calls.some((c) => c.path.startsWith('/api/v4') && c.status >= 400), calls.filter((c) => c.status >= 400).map((c) => `${c.method} ${c.path} ${c.status}`).join('; '));

mkdirSync(join(APP, 'test-results'), { recursive: true });
const failed = checks.filter((c) => !c.ok);
writeFileSync(join(APP, 'test-results/e2e-gitlab.json'), JSON.stringify({ at: new Date().toISOString(), pass: !failed.length, runs, checks, workflows: await waitWorkflows(0), logs: work }, null, 2));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed · runs: ${runs.map((r) => `${r.label} [${r.mode}]`).join('; ')}`);
console.log(`viewer: ${MOCK}/view${children.length && !process.argv.includes('--keep') ? ' (mock stops now; pass --keep to browse it)' : ''} · logs: ${work}`);
if (!process.argv.includes('--keep')) for (const c of children) process.kill(-c.pid);
else for (const c of children) c.unref();
process.exit(failed.length ? 1 : 0);
