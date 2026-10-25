import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { app } from '../src/gitlab/mock.ts';
import { FLOW_FILE, validateFlow } from '../../flows/simulate.ts';
import { parseDecisionCommands } from '../../ci/depmap-lib.mjs';

const demo = { 'private-token': 'glpat-demo' };
const json = (body: unknown, headers: Record<string, string> = demo) => ({ headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  await app.request('/mock/reset', { method: 'POST' });
});

describe('mock GitLab', () => {
  async function authorize(challenge: string) {
    const form = new URLSearchParams({ decision: 'authorize', client_id: 'depmap-local', redirect_uri: 'http://localhost:8787/api/oauth/callback', state: 's1', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read_api' });
    const res = await app.request('/oauth/authorize', { method: 'POST', body: form });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.searchParams.get('state')).toBe('s1');
    return to.searchParams.get('code')!;
  }
  const token = (code: string, verifier: string) => app.request('/oauth/token', {
    method: 'POST', ...json({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://localhost:8787/api/oauth/callback', client_id: 'depmap-local' }, {}),
  });

  it('rejects requests without a token', async () => {
    expect((await app.request('/api/v4/user')).status).toBe(401);
    expect((await app.request('/api/v4/user', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  });

  it('shows a consent page and completes OAuth with a valid PKCE verifier', async () => {
    const verifier = 'v'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const page = await app.request(`/oauth/authorize?response_type=code&client_id=depmap-local&redirect_uri=http://x/cb&state=s&scope=read_api&code_challenge=${challenge}`);
    expect(await page.text()).toContain('Authorize depmap-local to read your projects');
    const res = await token(await authorize(challenge), verifier);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: 'Bearer', scope: 'read_api' });
    const me = await app.request('/api/v4/user', { headers: { authorization: `Bearer ${body.access_token}` } });
    expect((await me.json()).username).toBe('demo');
  });

  it('rejects a wrong PKCE verifier and a reused code', async () => {
    const challenge = createHash('sha256').update('right').digest('base64url');
    const code = await authorize(challenge);
    const bad = await token(code, 'wrong');
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('invalid_grant');
    expect((await token(code, 'right')).status).toBe(200);
    expect((await token(code, 'right')).status).toBe(400);
  });

  it('stores uploads and serves them at the returned url', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'depmap.png');
    const res = await app.request('/api/v4/projects/1/uploads', { method: 'POST', headers: demo, body: form });
    expect(res.status).toBe(201);
    const up = await res.json();
    expect(up.markdown).toBe(`![depmap](${up.url})`);
    expect(up.url).toMatch(/^\/uploads\/[0-9a-f]{32}\/depmap\.png$/);
    const file = await app.request(up.url);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it('creates and updates MR notes, only by their author', async () => {
    const path = '/api/v4/projects/acme%2Fshop/merge_requests/1/notes';
    const created = await (await app.request(path, { method: 'POST', ...json({ body: 'first' }) })).json();
    expect(created.author.username).toBe('demo');
    const updated = await app.request(`${path}/${created.id}`, { method: 'PUT', ...json({ body: 'second' }) });
    expect((await updated.json()).body).toBe('second');
    const other = await app.request(`${path}/${created.id}`, { method: 'PUT', ...json({ body: 'hijack' }, { 'private-token': 'glpat-ai-depmap-acme' }) });
    expect(other.status).toBe(403);
    const notes = await (await app.request(path, { headers: demo })).json();
    expect(notes.map((n: any) => n.body)).toEqual(['second']);
  });

  it('serves demo repository files and MR diff refs from the same commit shas', async () => {
    const raw = await app.request('/api/v4/projects/1/repository/files/src%2Flog.js/raw?ref=chalk-5', { headers: demo });
    expect(await raw.text()).toContain("require('chalk')");
    const main = await (await app.request('/api/v4/projects/1/repository/commits/main', { headers: demo })).json();
    const mr = await (await app.request('/api/v4/projects/1/merge_requests/4', { headers: demo })).json();
    expect(mr.diff_refs.base_sha).toBe(main.id);
  });

  it('replaces scoped labels', async () => {
    const path = '/api/v4/projects/1/merge_requests/2';
    await app.request(path, { method: 'PUT', ...json({ add_labels: 'depmap::red,backend' }) });
    const mr = await (await app.request(path, { method: 'PUT', ...json({ add_labels: 'depmap::green' }) })).json();
    expect(mr.labels).toEqual(['backend', 'depmap::green']);
  });
});

describe('flow YAML', () => {
  const doc = () => parse(readFileSync(FLOW_FILE, 'utf8'));

  it('accepts flows/depmap.flow.yml', () => {
    expect(validateFlow(doc())).toEqual([]);
  });

  it('rejects unknown component types, missing prompts and unknown router targets', () => {
    const d = doc();
    d.components[0].type = 'MagicComponent';
    d.components[1].prompt_id = 'nope';
    d.routers[0].condition.routes.default_route = 'ghost';
    const errors = validateFlow(d).join('\n');
    expect(errors).toContain('unknown type MagicComponent');
    expect(errors).toContain('prompt nope is missing');
    expect(errors).toContain('unknown target ghost');
  });

  it('rejects a bad version and entry point', () => {
    const d = { ...doc(), version: 'v2', flow: { entry_point: 'missing' } };
    expect(validateFlow(d)).toEqual(expect.arrayContaining(['version must be "v1"', 'flow.entry_point missing is not a component']));
  });
});

describe('decision commands', () => {
  const note = (body: string, username = 'alice', id = 1) => ({ id, body, author: { username } });

  it('parses accept with a duration and pin, one per line', () => {
    const out = parseDecisionCommands([note('LGTM\n/depmap accept chalk@5.6.1 1d: replay demo\n/depmap pin debug@4.3.4: stay put')]);
    expect(out).toEqual([
      { action: 'accept', pv: 'chalk@5.6.1', days: 1, reason: 'replay demo', by: 'alice', noteId: 1 },
      { action: 'pin', pv: 'debug@4.3.4', days: null, reason: 'stay put', by: 'alice', noteId: 1 },
    ]);
  });

  it('handles scoped packages and a leading mention', () => {
    expect(parseDecisionCommands([note('@depmap /depmap accept @babel/core@7.25.0 14d: audited')])[0]).toMatchObject({ pv: '@babel/core@7.25.0', days: 14 });
  });

  it('ignores bots, service accounts, depmap reports and placeholders', () => {
    expect(parseDecisionCommands([
      note('/depmap accept a@1.0.0 1d: x', 'ai-depmap-acme'),
      note('/depmap accept a@1.0.0 1d: x', 'project_1_bot_abc'),
      note('<!-- depmap:report -->\n/depmap accept a@1.0.0 1d: x'),
      note('/depmap accept a@1.0.0 1d: <why the risk is acceptable>'),
      note('/depmap accept a@1.0.0 1d'),
    ])).toEqual([]);
  });
});
