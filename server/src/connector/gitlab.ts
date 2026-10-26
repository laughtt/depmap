import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { q } from '../db/db.ts';
import { mapLimit } from '../scanner/http.ts';

const key = createHash('sha256').update(process.env.APP_SECRET ?? 'local-dev-secret-change-me').digest();

export function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(blob: string) {
  const [iv, tag, data] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

export class GitLabError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// PATs and OAuth access tokens both work as Bearer tokens on the GitLab REST API
export async function gitlab(baseUrl: string, token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
  if (!res.ok) throw new GitLabError(res.status, `GitLab ${res.status} on ${path}`);
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

type OAuth = { refreshToken?: string; expiresIn?: number; scope?: string };

export async function createConnection(gitlabUrl: string, token: string, owner?: string, oauth: OAuth = {}) {
  const user = await gitlab(gitlabUrl, token, '/user');
  const id = randomUUID();
  const profile = { username: user.username, name: user.name, avatarUrl: user.avatar_url };
  // a personal access token reports its own scopes; an OAuth token's come with it
  const scope = oauth.scope ?? (await gitlab(gitlabUrl, token, '/personal_access_tokens/self').then((t) => t.scopes.join(' ')).catch(() => null));
  await q('insert into connection (id, gitlab_url, username, profile, token_enc, owner, scope, refresh_enc, expires_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [id, gitlabUrl, user.username, profile, encrypt(token), owner ?? `gitlab:${gitlabUrl}:${user.username}`, scope,
      oauth.refreshToken ? encrypt(oauth.refreshToken) : null, oauth.expiresIn ? new Date(Date.now() + oauth.expiresIn * 1000) : null]);
  return { id, gitlabUrl, user: profile };
}

export async function connection(id: string) {
  const [row] = await q('select * from connection where id = $1', [id]);
  if (!row) throw new GitLabError(404, 'unknown connection');
  if (row.refresh_enc && row.expires_at && new Date(row.expires_at).getTime() < Date.now() + 60_000) return { url: row.gitlab_url as string, token: await renew(row), scope: row.scope as string | null };
  return { url: row.gitlab_url as string, token: decrypt(row.token_enc), scope: row.scope as string | null };
}

async function renew(row: any) {
  const res = await fetch(`${row.gitlab_url.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_enc), client_id: process.env.OAUTH_CLIENT_ID ?? 'depmap-local',
      redirect_uri: `${process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`}/api/oauth/callback`,
      ...(process.env.OAUTH_CLIENT_SECRET && { client_secret: process.env.OAUTH_CLIENT_SECRET }) }),
  });
  if (!res.ok) throw new GitLabError(401, 'GitLab sign-in expired; sign in with GitLab again');
  const t = await res.json();
  await q('update connection set token_enc = $2, refresh_enc = $3, expires_at = $4 where id = $1', [row.id, encrypt(t.access_token), encrypt(t.refresh_token), new Date(Date.now() + t.expires_in * 1000)]);
  return t.access_token as string;
}

const SOURCE = /\.(m|c)?(j|t)sx?$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|vendor)\/|\.min\.js$/;

// pulls exactly what a scan needs: the lockfile, package.json and JS/TS sources (for upgrade-impact usage)
export async function fetchRepoFiles(url: string, token: string, projectId: string | number, ref?: string) {
  const project = await gitlab(url, token, `/projects/${encodeURIComponent(projectId)}`);
  const branch = ref ?? project.default_branch;
  const raw = (path: string) => gitlab(url, token, `/projects/${project.id}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`);
  const tree = async () => {
    const all: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await gitlab(url, token, `/projects/${project.id}/repository/tree?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(branch)}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  };
  const [lockfile, packageJson, entries, commit] = await Promise.all([
    raw('package-lock.json').catch((e) => (e.status === 404 ? raw('pnpm-lock.yaml') : Promise.reject(e))),
    raw('package.json'),
    tree(),
    gitlab(url, token, `/projects/${project.id}/repository/commits/${encodeURIComponent(branch)}`),
  ]);
  const paths = entries.filter((t) => t.type === 'blob' && SOURCE.test(t.path) && !SKIP.test(t.path)).slice(0, 200).map((t) => t.path);
  const sources = await mapLimit(paths, 10, async (path) => ({ path, content: String(await raw(path)) }));
  return {
    repo: project.path_with_namespace as string,
    webUrl: project.web_url as string,
    ref: branch as string,
    commitSha: commit.id as string,
    lockfile: typeof lockfile === 'string' ? lockfile : JSON.stringify(lockfile),
    packageJson: typeof packageJson === 'string' ? packageJson : JSON.stringify(packageJson),
    sources,
  };
}
