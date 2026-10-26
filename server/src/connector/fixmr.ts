import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { q } from '../db/db.ts';
import { remedies, type Remedy } from '../advisor/remedy.ts';
import { gitlab, GitLabError } from './gitlab.ts';

const run = promisify(execFile);

// the new version in package.json: the dependency's range when we depend on it, an override when it comes in through another package
export function editPackageJson(text: string, r: Remedy, pnpm: boolean) {
  const pj = JSON.parse(text), v = r.action!.version!;
  const indent = text.match(/^([ \t]+)"/m)?.[1] ?? '  ';
  const section = ['dependencies', 'devDependencies', 'optionalDependencies'].find((k) => pj[k]?.[r.name] !== undefined);
  if (r.direct && section) pj[section][r.name] = r.action!.kind === 'pin' ? v : `^${v}`;
  else if (pnpm) pj.pnpm = { ...pj.pnpm, overrides: { ...pj.pnpm?.overrides, [r.name]: v } };
  else pj.overrides = { ...pj.overrides, [r.name]: v };
  return JSON.stringify(pj, null, indent) + (text.endsWith('\n') ? '\n' : '');
}

// edits replace whole line ranges; applied bottom-up so earlier line numbers stay valid
export function applyEdits(content: string, edits: { startLine: number; endLine: number; before: string; after: string }[]) {
  const lines = content.split('\n');
  for (const e of [...edits].sort((a, b) => b.startLine - a.startLine)) {
    if (lines.slice(e.startLine - 1, e.endLine).join('\n').trimEnd() !== e.before.trimEnd()) throw new Error(`the code at line ${e.startLine} changed since the scan`);
    lines.splice(e.startLine - 1, e.endLine - e.startLine + 1, ...e.after.split('\n'));
  }
  return lines.join('\n');
}

// resolve the lockfile again for the new package.json; --ignore-scripts so no package code runs
async function relock(packageJson: string, lockName: string, lock: string, workspace: string | null) {
  const dir = await mkdtemp(join(tmpdir(), 'depmap-relock-'));
  try {
    await writeFile(join(dir, 'package.json'), packageJson);
    await writeFile(join(dir, lockName), lock);
    if (workspace) await writeFile(join(dir, 'pnpm-workspace.yaml'), workspace);
    const [cmd, args] = lockName === 'pnpm-lock.yaml'
      ? ['pnpm', ['install', '--lockfile-only', '--ignore-scripts', '--config.confirmModulesPurge=false']]
      : ['npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']];
    await run(cmd, args, { cwd: dir, timeout: 180_000, env: { ...process.env, CI: '1' } });
    return await readFile(join(dir, lockName), 'utf8');
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function openFixMr(snapshotId: number, pv: string, conn: { url: string; token: string }, by: string) {
  const [s] = await q('select s.repo, s.ref, s.commit_sha, s.web_url, g.lockfile from snapshot s join graph g using (lockfile_sha) where s.id = $1', [snapshotId]);
  const [r] = await remedies(snapshotId, [pv]);
  if (!r?.action?.version) throw new GitLabError(400, `${pv} has no version to move to; replace or remove it by hand`);
  const gl = (path: string, init?: RequestInit) => gitlab(conn.url, conn.token, path, init);
  const project = await gl(`/projects/${encodeURIComponent(s.repo)}`);
  const raw = (path: string) => gl(`/projects/${project.id}/repository/files/${encodeURIComponent(path)}/raw?ref=${s.commit_sha}`).then(String);
  const pnpm = !s.lockfile.trimStart().startsWith('{');
  const lockName = pnpm ? 'pnpm-lock.yaml' : 'package-lock.json';

  const packageJson = editPackageJson(await raw('package.json'), r, pnpm);
  const actions: { action: 'update'; file_path: string; content: string }[] = [{ action: 'update', file_path: 'package.json', content: packageJson }];
  const fix = r.ai?.status === 'done' ? r.ai.fix : null;
  const required = (fix?.edits ?? []).filter((e: any) => e.required);
  for (const file of new Set<string>(required.map((e: any) => e.file))) {
    actions.push({ action: 'update', file_path: file, content: applyEdits(await raw(file), required.filter((e: any) => e.file === file)) });
  }
  const lock = await relock(packageJson, lockName, s.lockfile, pnpm ? await raw('pnpm-workspace.yaml').catch(() => null) : null);
  if (lock) actions.push({ action: 'update', file_path: lockName, content: lock });

  const branch = `depmap/fix-${r.name.replace(/[@/]/g, '-').replace(/^-/, '')}-${r.action.version}`;
  const optional = (fix?.edits ?? []).filter((e: any) => !e.required);
  const description = [
    `**${r.action.text}**`, '',
    ...r.why.map((w) => `- ${w}`), '',
    `Changes: \`package.json\`${required.length ? `, ${required.length} code change${required.length > 1 ? 's' : ''} (written by ${fix.model}, ${fix.confidence} confidence)` : ''}${lock ? `, \`${lockName}\` regenerated` : ''}.`,
    ...(lock ? [] : ['', `The lockfile could not be regenerated here; run \`${pnpm ? 'pnpm install' : 'npm install'}\` on this branch.`]),
    ...(optional.length ? ['', 'Optional, not applied:', ...optional.flatMap((e: any) => ['', `\`${e.file}:${e.startLine}\`: ${e.why}`, '```diff', ...e.before.split('\n').map((l: string) => `-${l}`), ...e.after.split('\n').map((l: string) => `+${l}`), '```'])] : []),
    '', `Sources: ${[...r.sources, ...(fix?.sources ?? [])].slice(0, 8).map((x) => `[${x.label}](${x.url})`).join(' · ')}`,
    '', `_Opened by depmap for ${by}._`,
  ].join('\n');

  let mr: any;
  try {
    await gl(`/projects/${project.id}/repository/commits`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch, start_sha: s.commit_sha, commit_message: `depmap: ${r.action.text.split(':')[0].replace(/\.$/, '')}`, actions }) });
    mr = await gl(`/projects/${project.id}/merge_requests`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_branch: branch, target_branch: s.ref ?? project.default_branch, title: `Fix ${pv}: ${r.action.kind} ${r.name} to ${r.action.version}`, description, remove_source_branch: true }) });
  } catch (e) {
    // the branch exists from an earlier click: hand back its open merge request
    [mr] = await gl(`/projects/${project.id}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
    if (!mr) throw e;
  }
  await q("insert into decision (repo, pv, action, reason, by_user, mr_url) values ($1,$2,'fix',$3,$4,$5)", [s.repo, pv, `Fix merge request !${mr.iid}`, by, mr.web_url]);
  await q('insert into event (kind, repo, pv, payload) values ($1,$2,$3,$4)', ['decision', s.repo, pv, { action: 'fix', mrUrl: mr.web_url, by }]);
  return { mrUrl: mr.web_url as string, iid: mr.iid as number, lockfile: !!lock, codeChanges: required.length };
}
