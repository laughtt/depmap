import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { q } from '../db/db.ts';
import { scan } from '../scanner/scan.ts';
import { refresh } from '../scanner/refresh.ts';
import { DYN } from '../scanner/codec.ts';
import { WATCHERS, pollWatchers, namesPackage } from '../watchers/watchers.ts';
import { createConnection, connection, fetchRepoFiles, gitlab, GitLabError } from '../connector/gitlab.ts';

const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const APP_URL = process.env.APP_URL ?? PUBLIC_URL;
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'depmap-local';
const b64url = (b: Buffer) => b.toString('base64url');

export const api = new Hono();

api.onError((err, c) => {
  const status = err instanceof GitLabError ? (err.status === 401 ? 401 : 502) : 500;
  if (status === 500) console.error(err);
  return c.json({ error: err.message }, status);
});

api.get('/api/health', (c) => c.json({ ok: true }));

api.get('/api/repos', async (c) => {
  const rows = await q(`select repo, count(*)::int as snapshots, max(id) as latest_id from snapshot group by repo order by repo`);
  const latest = await q('select id, commit_sha, ref, created_at, counts from snapshot where id = any($1)', [rows.map((r) => r.latest_id)]);
  const reds = await q('select repo, array_agg((counts->>\'red\')::int order by id) as reds from snapshot group by repo');
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
    decision: decision ? { action: decision.action, reason: decision.reason, by: decision.by_user, expiresAt: decision.expires_at, createdAt: decision.created_at } : null,
  });
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
  return c.json(await createConnection(b.gitlabUrl, b.token));
});

api.get('/api/connections', async (c) => c.json((await q('select id, gitlab_url, username from connection order by created_at desc')).map((r) => ({ id: r.id, gitlabUrl: r.gitlab_url, username: r.username }))));

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
  const gitlabUrl = c.req.query('gitlabUrl') ?? 'http://localhost:8929';
  const state = b64url(randomBytes(16));
  const verifier = b64url(randomBytes(32));
  await q('insert into oauth_state (state, verifier, gitlab_url) values ($1,$2,$3)', [state, verifier, gitlabUrl]);
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID, redirect_uri: `${PUBLIC_URL}/api/oauth/callback`, response_type: 'code', scope: 'read_api', state,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  });
  return c.redirect(`${gitlabUrl.replace(/\/$/, '')}/oauth/authorize?${params}`);
});

api.get('/api/oauth/callback', async (c) => {
  const [st] = await q('delete from oauth_state where state = $1 and created_at > now() - interval \'10 minutes\' returning *', [c.req.query('state')]);
  if (!st) return c.text('OAuth state expired or unknown', 400);
  const res = await fetch(`${st.gitlab_url.replace(/\/$/, '')}/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, code: c.req.query('code'), grant_type: 'authorization_code', redirect_uri: `${PUBLIC_URL}/api/oauth/callback`, code_verifier: st.verifier }),
  });
  if (!res.ok) return c.text(`Token exchange failed (${res.status})`, 400);
  const { access_token } = await res.json();
  const conn = await createConnection(st.gitlab_url, access_token);
  return c.redirect(`${APP_URL}/#/connected/${conn.id}`);
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
