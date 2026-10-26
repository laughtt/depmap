// Shared helpers for the depmap CI scripts: Node built-ins and fetch only.
import { readFileSync } from 'node:fs';

export const env = process.env;
export const API = (env.DEPMAP_API_URL ?? 'http://localhost:8787').replace(/\/$/, '');
export const APP = (env.DEPMAP_APP_URL ?? API).replace(/\/$/, '');
export const GITLAB = (env.GITLAB_URL ?? env.CI_SERVER_URL ?? '').replace(/\/$/, '');
export const PROJECT = env.CI_PROJECT_ID;
export const MR = env.CI_MERGE_REQUEST_IID ? Number(env.CI_MERGE_REQUEST_IID) : undefined;
export const MARKER = '<!-- depmap:report -->';
export const COLORS = ['green', 'amber', 'red', 'grey'];

export async function http(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${text.slice(0, 200)}`), { status: res.status });
  return res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
}

const json = (method, body) => (body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// a depmap server with login on lets CI in with this shared token
export const auth = env.DEPMAP_TOKEN ? { authorization: `Bearer ${env.DEPMAP_TOKEN}` } : {};
export const depmap = (path, body) => {
  const init = json(body === undefined ? 'GET' : 'POST', body);
  return http(`${API}${path}`, { ...init, headers: { ...init.headers, ...auth } });
};

export function gitlab(path, { method = 'GET', body, form } = {}) {
  const init = form ? { method, body: form } : json(method, body);
  return http(`${GITLAB}/api/v4${path}`, { ...init, headers: { ...init.headers, authorization: `Bearer ${env.GITLAB_TOKEN ?? env.CI_JOB_TOKEN ?? ''}` } });
}

export const readResult = () => JSON.parse(readFileSync(env.DEPMAP_RESULT ?? 'depmap.json', 'utf8'));

const COMMAND = /^\s*(?:@\S+\s+)?\/depmap\s+(accept|pin)\s+(\S+@\S+?)(?:\s+(\d+)d)?\s*:\s*(.+?)\s*$/;
const isBot = (a) => a?.bot || a?.username?.startsWith('ai-') || a?.username?.includes('bot');

// `/depmap accept <pkg@ver> <N>d: <reason>` and `/depmap pin <pkg@ver>: <reason>`, from humans only, never from depmap's own report
export function parseDecisionCommands(notes) {
  const out = [];
  for (const n of notes) {
    if (isBot(n.author) || n.body.includes('<!-- depmap:')) continue;
    for (const line of n.body.split('\n')) {
      const m = line.match(COMMAND);
      if (m && !m[4].startsWith('<')) out.push({ action: m[1], pv: m[2], days: m[3] ? Number(m[3]) : null, reason: m[4], by: n.author.username, noteId: n.id });
    }
  }
  return out;
}

// gitlab-ci-local does not report to a GitLab, so the mock learns about jobs from the jobs themselves
export async function registerJob(trace, status = 'success') {
  if (env.GITLAB_MOCK_JOBS !== '1' || !GITLAB) return;
  await fetch(`${GITLAB}/mock/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT, jobId: env.CI_JOB_ID, pipelineId: env.CI_PIPELINE_ID, mrIid: MR, name: env.CI_JOB_NAME, stage: env.CI_JOB_STAGE, sha: env.CI_COMMIT_SHA, status, trace }),
  }).catch(() => {});
}

// console.log that also keeps the lines, so a job can register its own trace
export function logger() {
  const lines = [];
  const log = (...a) => {
    const s = a.join(' ');
    lines.push(s);
    console.log(s);
  };
  return { log, trace: () => lines.join('\n') + '\n' };
}
