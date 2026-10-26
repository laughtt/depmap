import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { q } from '../db/db.ts';
import { scan } from '../scanner/scan.ts';
import { refresh } from '../scanner/refresh.ts';
import { DYN } from '../scanner/codec.ts';
import { packageName } from '../scanner/lockfile.ts';
import { advisoryDetail } from '../scanner/osv.ts';
import { categoryOf } from '../scanner/classify.ts';
import semver from 'semver';
import { WATCHERS, pollWatchers, namesPackage } from '../watchers/watchers.ts';
import { createConnection, connection, fetchRepoFiles, gitlab, GitLabError } from '../connector/gitlab.ts';
import { remedies } from '../advisor/remedy.ts';
import { openFixMr } from '../connector/fixmr.ts';

const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const APP_URL = process.env.APP_URL ?? PUBLIC_URL;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'depmap-local';
const GITLAB_URL = process.env.GITLAB_URL ?? 'http://localhost:8929';
const REQUIRE_LOGIN = process.env.REQUIRE_LOGIN === '1';
const CI_TOKEN = process.env.DEPMAP_CI_TOKEN;
const b64url = (b: Buffer) => b.toString('base64url');
const sign = (id: string) => `${id}.${createHmac('sha256', process.env.APP_SECRET ?? 'local-dev-secret-change-me').update(id).digest('base64url')}`;

type User = { key: string; profile: { username: string; name: string; avatarUrl: string | null } };
export const api = new Hono<{ Variables: { user?: User } }>();

// the session cookie is "c:<connection id>" (signed in with GitLab) or "u:<username>" (depmap account), signed so it can't be forged
async function sessionUser(c: Context): Promise<User | null> {
  const v = getCookie(c, 'dm_session') ?? '', sid = v.slice(0, v.lastIndexOf('.'));
  if (!sid || sign(sid) !== v) return null;
  if (sid.startsWith('u:')) {
    const [u] = await q('select username from app_user where username = $1', [sid.slice(2)]);
    return u ? { key: `local:${u.username}`, profile: { username: u.username, name: u.username, avatarUrl: null } } : null;
  }
  if (!sid.startsWith('c:')) return null;
  const [row] = await q('select gitlab_url, username, profile from connection where id = $1', [sid.slice(2)]);
  return row ? { key: `gitlab:${row.gitlab_url}:${row.username}`, profile: row.profile } : null;
}

const startSession = (c: Context, sid: string) =>
  setCookie(c, 'dm_session', sign(sid), { path: '/', httpOnly: true, sameSite: 'Lax', secure: PUBLIC_URL.startsWith('https'), maxAge: 30 * 86400 });

export const hashPassword = (pw: string, salt = randomBytes(16)) => `${salt.toString('base64')}.${scryptSync(pw, salt, 32).toString('base64')}`;
const checkPassword = (pw: string, stored: string) => {
  const [salt, hash] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  return timingSafeEqual(scryptSync(pw, salt, 32), hash);
};

api.use('/api/*', async (c, next) => {
  if (!REQUIRE_LOGIN || /^\/api\/(health|me|login|signup|logout|oauth\/)/.test(c.req.path)) return next();
  if (CI_TOKEN && c.req.header('authorization') === `Bearer ${CI_TOKEN}`) return next();
  const user = await sessionUser(c);
  if (!user) return c.json({ error: 'Sign in first' }, 401);
  c.set('user', user);
  return next();
});

// a signed-in user only sees the GitLab connections they made
api.use('/api/connections/:id/*', async (c, next) => {
  const u = c.get('user');
  if (u && !(await q('select 1 from connection where id = $1 and owner = $2', [c.req.param('id'), u.key])).length) return c.json({ error: 'unknown connection' }, 404);
  return next();
});

api.onError((err, c) => {
  const status = err instanceof GitLabError ? (err.status === 401 ? 401 : 502) : 500;
  if (status === 500) console.error(err);
  return c.json({ error: err.message }, status);
});

api.get('/api/health', (c) => c.json({ ok: true }));

api.get('/api/me', async (c) => c.json({ loginRequired: REQUIRE_LOGIN, gitlabUrl: GITLAB_URL, user: (await sessionUser(c))?.profile ?? null }));

api.post('/api/signup', async (c) => {
  const { username = '', password = '' } = await c.req.json();
  if (!/^[a-z0-9_-]{3,32}$/i.test(username) || String(password).length < 8)
    return c.json({ error: 'Use 3 to 32 letters, digits, - or _ for the username, and at least 8 characters for the password' }, 400);
  const [row] = await q('insert into app_user (username, password_hash) values ($1, $2) on conflict do nothing returning username', [username.toLowerCase(), hashPassword(String(password))]);
  if (!row) return c.json({ error: 'That username is taken' }, 409);
  startSession(c, `u:${row.username}`);
  return c.json({ ok: true });
});

api.post('/api/login', async (c) => {
  const { username = '', password = '' } = await c.req.json();
  const [row] = await q('select username, password_hash from app_user where username = $1', [String(username).toLowerCase()]);
  if (!row || !checkPassword(String(password), row.password_hash)) return c.json({ error: 'Wrong username or password' }, 401);
  startSession(c, `u:${row.username}`);
  return c.json({ ok: true });
});

api.get('/api/logout', (c) => {
  deleteCookie(c, 'dm_session', { path: '/' });
  return c.redirect(`${APP_URL}/`);
});

api.get('/api/repos', async (c) => {
  const rows = await q(`select repo, count(*)::int as snapshots, max(id) as latest_id from snapshot where kind <> 'crawl' group by repo order by repo`);
  const latest = await q('select id, commit_sha, ref, created_at, counts from snapshot where id = any($1)', [rows.map((r) => r.latest_id)]);
  const reds = await q('select repo, array_agg((counts->>\'red\')::int order by id) as reds from snapshot where kind <> \'crawl\' group by repo');
  return c.json(rows.map((r) => {
    const l = latest.find((x) => x.id === r.latest_id);
    return { repo: r.repo, snapshots: r.snapshots, latest: { id: l.id, commitSha: l.commit_sha, ref: l.ref, createdAt: l.created_at, counts: l.counts }, redHistory: reds.find((x) => x.repo === r.repo)?.reds ?? [] };
  }));
});

api.get('/api/repos/:repo/snapshots', async (c) => {
  const rows = await q('select id, commit_sha, ref, kind, mr_iid, created_at, as_of, lockfile_sha, counts, gate, metrics from snapshot where repo = $1 order by id', [c.req.param('repo')]);
  return c.json(rows.map((r) => ({ id: r.id, commitSha: r.commit_sha, ref: r.ref, kind: r.kind, mrIid: r.mr_iid, createdAt: r.created_at, asOf: r.as_of, lockfileSha: r.lockfile_sha, counts: r.counts, gate: r.gate, metrics: r.metrics })));
});

api.get('/api/graphs/:file', async (c) => {
  const [row] = await q('select bin from graph where lockfile_sha = $1', [c.req.param('file').replace(/\.bin$/, '')]);
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.body(row.bin, 200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
});

// colours are frozen per snapshot; decisions made since then are overlaid so the UI reflects them immediately
api.get('/api/snapshots/:id/state', async (c) => {
  const [s] = await q('select s.*, g.pvs from snapshot s join graph g using (lockfile_sha) where s.id = $1', [Number(c.req.param('id'))]);
  if (!s) return c.json({ error: 'not found' }, 404);
  const decided = new Set((await q("select pv from decision where repo = $1 and action = 'accept' and (expires_at is null or expires_at > now())", [s.repo])).map((d) => d.pv));
  const flags = Buffer.from(s.flags);
  s.pvs.forEach((pv: string, i: number) => { if (decided.has(pv)) flags[i] |= DYN.decided; });
  return c.json({ snapshotId: s.id, lockfileSha: s.lockfile_sha, asOf: s.as_of, color: Buffer.from(s.color).toString('base64'), flags: flags.toString('base64'), counts: s.counts, gate: s.gate });
});

api.get('/api/snapshots/:id/delta', async (c) => {
  const id = Number(c.req.param('id'));
  const [s] = await q('select delta from snapshot where id = $1', [id]);
  if (!s) return c.json({ error: 'not found' }, 404);
  const advice = (await q('select data from advice where snapshot_id = $1 order by package', [id])).map((r) => r.data);
  return c.json({ ...(s.delta ?? { baseSnapshotId: null, added: [], removed: [], upgraded: [], colorChanged: [] }), advice });
});

api.get('/api/pv', async (c) => {
  const pv = c.req.query('pv') ?? '';
  const snapshot = Number(c.req.query('snapshot'));
  const [s] = await q('select repo from snapshot where id = $1', [snapshot]);
  const [detail] = await q('select * from snapshot_pv where snapshot_id = $1 and pv = $2', [snapshot, pv]);
  const [pvRow] = await q('select facts from package_version where pv = $1', [pv]);
  const name = pv.slice(0, pv.lastIndexOf('@'));
  const [advice] = await q('select data from advice where snapshot_id = $1 and package = $2', [snapshot, name]);
  const [decision] = s ? await q('select * from decision where repo = $1 and pv = $2 and (expires_at is null or expires_at > now()) order by id desc limit 1', [s.repo, pv]) : [];
  const f = pvRow?.facts;
  return c.json({
    pv, name, version: pv.slice(pv.lastIndexOf('@') + 1),
    color: detail?.color ?? (f ? 0 : 3),
    reasons: detail?.reasons ?? [],
    fingerprint: detail?.fingerprint ?? null,
    facts: f ? { publishedAt: f.publishedAt, publisher: f.publisher, maintainers: f.maintainers, installScripts: f.installScripts, provenance: f.provenance, deprecated: f.deprecated ?? null, license: f.license, unpublished: f.unpublished, weeklyDownloads: f.weeklyDownloads, latest: f.latest } : null,
    advisories: detail?.advisories ?? [],
    upgrade: advice?.data ?? null,
    decision: decision ? { action: decision.action, reason: decision.reason, by: decision.by_user, expiresAt: decision.expires_at, createdAt: decision.created_at, mrUrl: decision.mr_url } : null,
  });
});

// the world graph: every package we have ever scanned, folded by name, not tied to a repo
const WORST = [0, 2, 3, 1]; // rank of green, amber, red, grey
const worse = (a: number, b: number) => (WORST[b] > WORST[a] ? b : a);

// a version's colour comes from the newest snapshot whose graph contains it
async function latestColors(pvs?: string[]) {
  const rows = await q(`select distinct on (s.lockfile_sha) s.id, s.color, g.pvs from snapshot s join graph g using (lockfile_sha)
    ${pvs ? 'where g.pvs && $1' : ''} order by s.lockfile_sha, s.id desc`, pvs ? [pvs] : []);
  const out = new Map<string, { color: number; snapshotId: number }>();
  for (const r of rows) r.pvs.forEach((pv: string, i: number) => {
    if ((out.get(pv)?.snapshotId ?? -1) < r.id) out.set(pv, { color: r.color[i], snapshotId: r.id });
  });
  return out;
}

api.get('/api/world', async (c) => {
  const [pvs, edges, colors] = await Promise.all([
    q(`select p.name, p.version, p.facts->>'publishedAt' as at, p.facts->>'latest' as latest, jsonb_array_length(coalesce(p.facts->'maintainers', '[]')) as maintainers,
      (p.facts->>'provenance')::bool as provenance, p.facts->>'deprecated' as deprecated, u.runtime, u.direct, u.install
      from package_version p left join pv_use u using (pv) order by p.name, p.facts->>'publishedAt'`),
    q(`select distinct regexp_replace(parent, '@[^@]*$', '') as a, regexp_replace(child, '@[^@]*$', '') as b from pv_edge`),
    latestColors(),
  ]);
  const nodes = new Map<string, { name: string; versions: string[]; dependents: number; color: number; category: string; use: string[]; trust: string[]; newest: any; provenance: boolean }>();
  for (const r of pvs) {
    const n = nodes.get(r.name) ?? nodes.set(r.name, { name: r.name, versions: [], dependents: 0, color: 0, category: categoryOf(r.name), use: [], trust: [], newest: r, provenance: false }).get(r.name)!;
    n.versions.push(r.version);
    n.color = worse(n.color, colors.get(`${r.name}@${r.version}`)?.color ?? 3);
    n.newest = r; // rows are ordered by publish date
    n.provenance ||= !!r.provenance;
    for (const [flag, label] of [['runtime', 'runtime'], ['direct', 'direct'], ['install', 'install-script']] as const) if (r[flag] && !n.use.includes(label)) n.use.push(label);
  }
  const links = edges.filter((e) => e.a !== e.b && nodes.has(e.a) && nodes.has(e.b));
  for (const e of links) nodes.get(e.b)!.dependents++;
  const twoYears = Date.now() - 2 * 365 * 864e5;
  return c.json({
    nodes: [...nodes.values()].map(({ newest: x, provenance, ...n }) => {
      if (!n.use.includes('runtime')) n.use.unshift('dev-only');
      const trust = [
        x.maintainers === 1 && 'one-maintainer',
        x.maintainers === 1 && n.dependents >= 10 && 'load-bearing',
        !provenance && 'no-provenance',
        x.latest === x.version && x.at && Date.parse(x.at) < twoYears && 'stale',
        x.deprecated && 'deprecated',
        n.use.includes('install-script') && 'install-script',
      ].filter(Boolean) as string[];
      return { ...n, trust };
    }),
    edges: links.map((e) => [e.a, e.b]),
  });
});

api.get('/api/world/package', async (c) => {
  const name = c.req.query('name') ?? '';
  const rows = await q('select pv, version, facts from package_version where name = $1', [name]);
  const pvs = rows.map((r) => r.pv);
  const [colors, used, parents] = await Promise.all([
    latestColors(pvs),
    q('select distinct s.repo, s.ref, p as pv from snapshot s join graph g using (lockfile_sha), unnest(g.pvs) p where g.pvs && $1 and p = any($1) order by s.repo', [pvs]),
    q('select distinct parent from pv_edge where child = any($1)', [pvs]),
  ]);
  const details = await q('select distinct on (pv) pv, reasons, advisories, fingerprint from snapshot_pv where (snapshot_id, pv) in (select * from unnest($1::int[], $2::text[])) order by pv',
    [pvs.map((pv) => colors.get(pv)?.snapshotId ?? 0), pvs]);
  const versions = rows.map((r) => {
    const d = details.find((x) => x.pv === r.pv), f = r.facts;
    return {
      version: r.version, color: colors.get(r.pv)?.color ?? 3,
      publishedAt: f?.publishedAt ?? null, publisher: f?.publisher ?? null, provenance: f?.provenance ?? null,
      installScripts: f?.installScripts ?? [], deprecated: f?.deprecated ?? null, license: f?.license ?? null,
      reasons: d?.reasons ?? [], advisories: d?.advisories ?? [], fingerprint: d?.fingerprint ?? null, remedy: null as any,
      repos: [...new Set(used.filter((u) => u.pv === r.pv).map((u) => `${u.repo}${u.ref ? `@${u.ref}` : ''}`))],
    };
  }).sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  // without a fixed release (malware, unfixed bugs) the remedy is the newest version we have seen that is clean
  const clean = versions.find((v) => !v.advisories.length && v.color !== 2)?.version ?? null;
  for (const v of versions) {
    if (!v.advisories.length) continue;
    const detail = await Promise.all(v.advisories.map((a: any) => advisoryDetail(a.id, name, v.version)));
    v.advisories = v.advisories.map((a: any, k: number) => ({ ...a, detail: detail[k], remedy: detail[k]?.fixedIn
      ? { kind: 'upgrade', version: detail[k]!.fixedIn!.version, bump: detail[k]!.fixedIn!.bump }
      : clean ? { kind: 'switch', version: clean } : { kind: 'remove' } }));
    // one upgrade that clears every advisory on this version, when each has a fixed release
    const fixes = detail.map((d) => d?.fixedIn?.version);
    const all = fixes.every(Boolean) ? (fixes as string[]).sort(semver.compare).at(-1)! : null;
    v.remedy = all ? { kind: 'upgrade', version: all, bump: semver.diff(v.version, all), clears: fixes.length } : clean && clean !== v.version ? { kind: 'switch', version: clean } : { kind: 'remove' };
  }
  return c.json({ name, versions, dependents: [...new Set(parents.map((p) => packageName(p.parent)))].sort() });
});

api.post('/api/decisions', async (c) => {
  const b = await c.req.json();
  if (!b.repo || !b.pv || !['accept', 'pin'].includes(b.action) || !b.reason) return c.json({ error: 'repo, pv, action (accept|pin) and reason are required' }, 400);
  const [d] = await q('insert into decision (repo, pv, action, reason, by_user, expires_at) values ($1,$2,$3,$4,$5,$6) returning *', [b.repo, b.pv, b.action, b.reason, b.by ?? null, b.expiresAt ?? null]);
  await q('insert into event (kind, repo, pv, payload) values ($1,$2,$3,$4)', ['decision', b.repo, b.pv, { action: b.action, reason: b.reason, by: b.by, expiresAt: b.expiresAt }]);
  return c.json({ ok: true, decision: d });
});

api.delete('/api/decisions/:id', async (c) => {
  const [d] = await q('delete from decision where id = $1 returning *', [Number(c.req.param('id'))]);
  if (!d) return c.json({ error: 'not found' }, 404);
  await q('insert into event (kind, repo, pv, payload) values ($1,$2,$3,$4)', ['decision-revoked', d.repo, d.pv, { action: d.action }]);
  return c.json({ ok: true });
});

api.get('/api/events', async (c) => {
  const repo = c.req.query('repo');
  const rows = await q('select * from event where ($1::text is null or repo = $1) order by id desc limit 200', [repo ?? null]);
  const COLORS = ['green', 'amber', 'red', 'grey'];
  const title = (r: any) => ({
    scan: `Scanned ${r.payload.ref ?? ''}${r.payload.mrIid ? ` (MR !${r.payload.mrIid})` : ''}`,
    red: `${r.pv} is red`,
    advisory: `${r.pv}: ${COLORS[r.payload.from]} → ${COLORS[r.payload.to]}`,
    decision: `${r.payload.action === 'accept' ? 'Accepted' : 'Pinned'} ${r.pv}`,
    'watch-poll': 'Security watchers polled',
  } as Record<string, string>)[r.kind] ?? r.kind;
  return c.json(rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, repo: r.repo, pv: r.pv, snapshotId: r.snapshot_id, title: title(r), payload: { ...r.payload, pv: r.pv, title: title(r) } })));
});

api.post('/api/scan', async (c) => {
  const b = await c.req.json();
  if (!b.repo || !b.lockfile) return c.json({ error: 'repo and lockfile are required' }, 400);
  return c.json(await scan(b));
});

api.post('/api/refresh', async (c) => {
  const b = await c.req.json().catch(() => ({}));
  return c.json(await refresh(b.asOf));
});

// repo connector: tokens are validated against GitLab, then stored encrypted; the browser never keeps them
api.post('/api/connections', async (c) => {
  const b = await c.req.json();
  if (!b.gitlabUrl || !b.token) return c.json({ error: 'gitlabUrl and token are required' }, 400);
  return c.json(await createConnection(b.gitlabUrl, b.token, c.get('user')?.key));
});

api.get('/api/connections', async (c) => c.json((await (c.get('user')
  ? q('select id, gitlab_url, username from connection where owner = $1 order by created_at desc', [c.get('user')!.key])
  : q('select id, gitlab_url, username from connection order by created_at desc'))).map((r) => ({ id: r.id, gitlabUrl: r.gitlab_url, username: r.username }))));

api.get('/api/connections/:id/projects', async (c) => {
  const { url, token } = await connection(c.req.param('id'));
  const projects = await gitlab(url, token, '/projects?membership=true&simple=true&per_page=50&order_by=last_activity_at');
  return c.json(projects.map((p: any) => ({ id: p.id, pathWithNamespace: p.path_with_namespace, defaultBranch: p.default_branch, webUrl: p.web_url, lastActivityAt: p.last_activity_at })));
});

api.post('/api/connections/:id/import', async (c) => {
  const b = await c.req.json();
  const { url, token } = await connection(c.req.param('id'));
  const files = await fetchRepoFiles(url, token, b.projectId, b.ref);
  const result = await scan({ ...files, kind: 'push' });
  return c.json({ repo: files.repo, snapshotId: result.snapshotId, counts: result.counts });
});

api.get('/api/oauth/start', async (c) => {
  // with login on, only the configured GitLab may vouch for who you are
  const gitlabUrl = (REQUIRE_LOGIN ? undefined : c.req.query('gitlabUrl')) ?? GITLAB_URL;
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  // sign-in only reads; write access (to open fix merge requests) is asked for when someone wants one
  const scope = c.req.query('scope') === 'api' ? 'api' : 'read_api';
  const back = c.req.query('return') ?? '';
  await q('insert into oauth_state (state, verifier, gitlab_url, scope, return_to) values ($1,$2,$3,$4,$5)', [state, verifier, gitlabUrl, scope, /^\/(?!\/)/.test(back) ? back : null]);
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID, redirect_uri: `${PUBLIC_URL}/api/oauth/callback`, response_type: 'code', scope, state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  return c.redirect(`${gitlabUrl.replace(/\/$/, '')}/oauth/authorize?${params}`);
});

// GitLab lands here; answer with a dark page at once and do the token exchange behind it, so there is no white wait
api.get('/api/oauth/callback', (c) => c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signing in…</title>
<style>html,body{margin:0;height:100%;background:#06080d;color:#8d97a8;font:14px system-ui,sans-serif}html.light,html.light body{background:#f3f5f8;color:#5b6575}
main{height:100%;display:grid;place-items:center}i{display:inline-block;width:12px;height:12px;margin-right:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:s .8s linear infinite;vertical-align:-2px}@keyframes s{to{transform:rotate(360deg)}}a{color:#9db4ff}</style>
<script>try{if(localStorage.getItem("depmap-theme")==="light")document.documentElement.className="light"}catch(e){}</script></head>
<body><main><p id="m"><i></i>Signing you in with GitLab…</p></main><script>
const p=new URLSearchParams(location.search);
fetch("/api/oauth/finish",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:p.get("code"),state:p.get("state"),error:p.get("error")})})
.then(r=>r.json()).then(d=>{if(d.redirect)location.replace(d.redirect);else throw new Error(d.error)})
.catch(e=>{document.getElementById("m").innerHTML="Sign-in did not finish: "+String(e.message).replace(/</g,"&lt;")+'. <a href="/">Try again</a>'});
</script></body></html>`));

api.post('/api/oauth/finish', async (c) => {
  const b = await c.req.json();
  if (b.error) return c.json({ error: b.error === 'access_denied' ? 'access was not granted on GitLab' : b.error }, 400);
  const [st] = await q('delete from oauth_state where state = $1 and created_at > now() - interval \'10 minutes\' returning *', [b.state]);
  if (!st) return c.json({ error: 'the sign-in link expired' }, 400);
  const res = await fetch(`${st.gitlab_url.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, code: b.code, grant_type: 'authorization_code', redirect_uri: `${PUBLIC_URL}/api/oauth/callback`, code_verifier: st.verifier,
      ...(process.env.OAUTH_CLIENT_SECRET && { client_secret: process.env.OAUTH_CLIENT_SECRET }) }),
  });
  if (!res.ok) return c.json({ error: `GitLab refused the sign-in (${res.status})` }, 400);
  const t = await res.json();
  // already signed in: this only connects GitLab (or adds write access); otherwise it is the sign-in
  const me = await sessionUser(c);
  const conn = await createConnection(st.gitlab_url, t.access_token, me?.key, { refreshToken: t.refresh_token, expiresIn: t.expires_in, scope: t.scope ?? st.scope });
  if (!me) startSession(c, `c:${conn.id}`);
  return c.json({ redirect: `${APP_URL}${st.return_to ?? `/connected/${conn.id}`}` });
});

api.get('/api/watchers', async (c) => {
  const counts = await q('select source, count(*)::int as n, max(published) as latest from watch_item group by source');
  const [poll] = await q("select at, payload from event where kind = 'watch-poll' order by id desc limit 1");
  return c.json({ lastPoll: poll?.at ?? null, sources: WATCHERS.map((w) => ({ ...w, items: counts.find((x) => x.source === w.id)?.n ?? 0, latest: counts.find((x) => x.source === w.id)?.latest ?? null })) });
});

// recent posts, each with the packages it names from the repo's latest graph
api.get('/api/watchers/items', async (c) => {
  const repo = c.req.query('repo');
  const items = await q('select * from watch_item order by published desc limit $1', [repo ? 2000 : Number(c.req.query('limit') ?? 60)]);
  let names = new Set<string>();
  if (repo) {
    const [s] = await q('select g.pvs from snapshot s join graph g using (lockfile_sha) where s.repo = $1 order by s.id desc limit 1', [repo]);
    names = new Set((s?.pvs ?? []).slice(1).map((pv: string) => pv.slice(0, pv.lastIndexOf('@'))).filter((n: string) => n.length >= 4));
  }
  const list = items.map((it) => {
    const matched = [...names].filter((n) => namesPackage(it, n));
    return { id: it.id, source: it.source, title: it.title, url: it.url, published: it.published, summary: it.summary.slice(0, 280), packages: it.packages, matched };
  });
  const matchedOnly = c.req.query('matchedOnly') === '1';
  // posts naming this repo's packages come first; then the newest
  return c.json((matchedOnly ? list.filter((x) => x.matched.length) : list).sort((a, b) => Number(b.matched.length > 0) - Number(a.matched.length > 0)));
});

api.post('/api/watchers/poll', async (c) => c.json({ sources: await pollWatchers({ fresh: c.req.query('fresh') === '1' }) }));

// CycloneDX 1.5 with depmap risk as component properties; GitLab ingests it as a cyclonedx report artifact
// for each red or amber package: where our code reaches it, the fix with its package.json edit, alternatives, why and sources
// ?wait=N holds the answer up to N seconds while AI fixes for this snapshot are still being written (CI uses it)
api.get('/api/snapshots/:id/remedies', async (c) => {
  const id = Number(c.req.param('id')), until = Date.now() + Math.min(Number(c.req.query('wait') ?? 0), 120) * 1000;
  while (Date.now() < until && (await q("select 1 from ai_fix where snapshot_id = $1 and status in ('queued', 'running') limit 1", [id])).length) await new Promise((r) => setTimeout(r, 1000));
  return c.json(await remedies(id, c.req.query('pv') ? [c.req.query('pv')!] : undefined));
});

// opens a merge request with the fix, as the signed-in user, through their GitLab connection that may write
api.post('/api/snapshots/:id/fix-mr', async (c) => {
  const b = await c.req.json();
  const [s] = await q('select web_url from snapshot where id = $1', [Number(c.req.param('id'))]);
  if (!s?.web_url) return c.json({ error: 'This scan did not come from GitLab, so there is no project to open a merge request in.' }, 400);
  const u = c.get('user');
  const [conn] = await q("select id from connection where gitlab_url = $1 and scope ~ '(^| )api( |$)' and ($2::text is null or owner = $2) order by created_at desc limit 1", [new URL(s.web_url).origin, u?.key ?? null]);
  if (!conn) return c.json({ error: 'Allow depmap to open merge requests on GitLab first.', authorize: `/api/oauth/start?scope=api&return=${encodeURIComponent(b.return ?? '/')}` }, 409);
  return c.json(await openFixMr(Number(c.req.param('id')), b.pv, await connection(conn.id), u?.profile.username ?? 'depmap'));
});

api.get('/api/snapshots/:id/sbom.cdx.json', async (c) => {
  const [s] = await q('select s.*, g.pvs, g.bin from snapshot s join graph g using (lockfile_sha) where s.id = $1', [Number(c.req.param('id'))]);
  if (!s) return c.json({ error: 'not found' }, 404);
  const details = new Map((await q('select pv, color, reasons, fingerprint, advisories from snapshot_pv where snapshot_id = $1', [s.id])).map((r) => [r.pv, r]));
  const bin: Buffer = s.bin;
  const n = bin.readUInt32LE(8), e = bin.readUInt32LE(12);
  const head = 20 + 2 * n;
  const off = head + ((4 - (head % 4)) % 4) + 4 * n;
  const deps = new Map<number, number[]>();
  for (let k = 0; k < e; k++) {
    const a = bin.readUInt32LE(off + 4 * k), b = bin.readUInt32LE(off + 4 * (e + k));
    (deps.get(a) ?? deps.set(a, []).get(a)!).push(b);
  }
  const split = (pv: string) => [pv.slice(0, pv.lastIndexOf('@')), pv.slice(pv.lastIndexOf('@') + 1)];
  const purl = (pv: string) => { const [name, version] = split(pv); return `pkg:npm/${name.replace('@', '%40')}@${version}`; };
  const COLORS = ['green', 'amber', 'red', 'grey'];
  const [rootName, rootVersion] = split(s.pvs[0]);
  const vulns = new Map<string, any>();
  for (const d of details.values()) for (const a of d.advisories) {
    const v = vulns.get(a.id) ?? vulns.set(a.id, { id: a.id, source: { name: 'OSV', url: a.url }, ratings: [{ severity: a.severity.toLowerCase() }], description: a.summary, affects: [] }).get(a.id);
    v.affects.push({ ref: d.pv });
  }
  return c.json({
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${createHash('md5').update(`${s.id}`).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')}`, version: 1,
    metadata: {
      timestamp: new Date(s.as_of).toISOString(),
      tools: { components: [{ type: 'application', name: 'depmap', version: '0.1.0' }] },
      component: { type: 'application', name: rootName, version: rootVersion, 'bom-ref': s.pvs[0] },
      properties: [
        { name: 'gitlab:meta:schema_version', value: '1' },
        { name: 'gitlab:dependency_scanning:input_file:path', value: 'package-lock.json' },
        { name: 'gitlab:dependency_scanning:package_manager:name', value: 'npm' },
        { name: 'gitlab:dependency_scanning:language:name', value: 'JavaScript' },
      ],
    },
    components: s.pvs.slice(1).map((pv: string, j: number) => {
      const i = j + 1;
      const [name, version] = split(pv);
      const d = details.get(pv);
      return {
        type: 'library', 'bom-ref': pv, name, version, purl: purl(pv), scope: bin[20 + n + i] & 2 ? 'optional' : 'required',
        properties: [
          { name: 'depmap:risk', value: COLORS[s.color[i]] },
          ...(d ? [{ name: 'depmap:reasons', value: d.reasons.map((r: any) => r.code).join(',') }] : []),
          ...(d?.fingerprint ? [{ name: 'depmap:fingerprint', value: d.fingerprint.id }] : []),
        ],
      };
    }),
    dependencies: s.pvs.map((pv: string, i: number) => ({ ref: pv, dependsOn: (deps.get(i) ?? []).map((b) => s.pvs[b]) })),
    vulnerabilities: [...vulns.values()],
  });
});

// blast radius: red and amber versions that the latest scan of two or more repos contains
api.get('/api/blast', async (c) => {
  const rows = await q(`with latest as (select distinct on (repo) id, repo from snapshot where kind <> 'crawl' order by repo, id desc)
    select d.pv, max(d.color)::int as color, (array_agg(d.reasons order by d.color desc))[1] as reasons,
      json_agg(json_build_object('repo', l.repo, 'snapshotId', l.id) order by l.repo) as repos
    from snapshot_pv d join latest l on l.id = d.snapshot_id where d.color in (1, 2)
    group by d.pv having count(*) > 1 order by max(d.color) desc, count(*) desc, d.pv`);
  return c.json(rows.map((r) => ({ pv: r.pv, color: r.color, reason: r.reasons[0] ?? null, repos: r.repos })));
});
