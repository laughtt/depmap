import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { q } from '../db/db.ts';

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

export async function createConnection(gitlabUrl: string, token: string) {
  const user = await gitlab(gitlabUrl, token, '/user');
  const id = randomUUID();
  const profile = { username: user.username, name: user.name, avatarUrl: user.avatar_url };
  await q('insert into connection (id, gitlab_url, username, profile, token_enc) values ($1,$2,$3,$4,$5)', [id, gitlabUrl, user.username, profile, encrypt(token)]);
  return { id, gitlabUrl, user: profile };
}

export async function connection(id: string) {
  const [row] = await q('select * from connection where id = $1', [id]);
  if (!row) throw new GitLabError(404, 'unknown connection');
  return { url: row.gitlab_url as string, token: decrypt(row.token_enc) };
}

const SOURCE = /\.(m|c)?(j|t)sx?$/;

// pulls exactly what a scan needs: the lockfile, package.json and JS/TS sources (for upgrade-impact usage)
export async function fetchRepoFiles(url: string, token: string, projectId: string | number, ref?: string) {
  const project = await gitlab(url, token, `/projects/${encodeURIComponent(projectId)}`);
  const branch = ref ?? project.default_branch;
  const raw = (path: string) => gitlab(url, token, `/projects/${project.id}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(branch)}`);
  const [lockfile, packageJson, tree, commit] = await Promise.all([
    raw('package-lock.json').catch((e) => (e.status === 404 ? raw('pnpm-lock.yaml') : Promise.reject(e))),
    raw('package.json'),
    gitlab(url, token, `/projects/${project.id}/repository/tree?recursive=true&per_page=100&ref=${encodeURIComponent(branch)}`),
    gitlab(url, token, `/projects/${project.id}/repository/commits/${encodeURIComponent(branch)}`),
  ]);
  const paths = (tree as any[]).filter((t) => t.type === 'blob' && SOURCE.test(t.path) && !t.path.includes('node_modules/')).slice(0, 200).map((t) => t.path);
  const sources = await Promise.all(paths.map(async (path) => ({ path, content: String(await raw(path)) })));
  return {
    repo: project.path_with_namespace as string,
    ref: branch as string,
    commitSha: commit.id as string,
    lockfile: typeof lockfile === 'string' ? lockfile : JSON.stringify(lockfile),
    packageJson: typeof packageJson === 'string' ? packageJson : JSON.stringify(packageJson),
    sources,
  };
}
