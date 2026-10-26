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
  // an upgrade is a range (^fixed) so a parent that also moves can still get its newer copy; a pin is exact
  const pj = JSON.parse(text), v = r.action!.kind === 'pin' ? r.action!.version! : `^${r.action!.version}`;
  const indent = text.match(/^([ \t]+)"/m)?.[1] ?? '  ';
  const section = ['dependencies', 'devDependencies', 'optionalDependencies'].find((k) => pj[k]?.[r.name] !== undefined);
  if (r.direct && section) pj[section][r.name] = v;
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

// one merge request for one package, or for every red package of a scan ("fix all")
export async function openFixMr(snapshotId: number, pvs: string[], conn: { url: string; token: string }, by: string) {
  const [s] = await q('select s.repo, s.ref, s.commit_sha, s.web_url, g.lockfile from snapshot s join graph g using (lockfile_sha) where s.id = $1', [snapshotId]);
  // transitive fixes stay in even when their parent moves too: a parent's new version may still pin the vulnerable one
  const chosen = (await remedies(snapshotId, pvs)).filter((r) => r.action?.version);
  if (!chosen.length) throw new GitLabError(400, `${pvs.length === 1 ? pvs[0] : 'These packages'} have no version to move to; replace or remove them by hand`);
  const gl = (path: string, init?: RequestInit) => gitlab(conn.url, conn.token, path, init);
  const project = await gl(`/projects/${encodeURIComponent(s.repo)}`);
  const raw = (path: string) => gl(`/projects/${project.id}/repository/files/${encodeURIComponent(path)}/raw?ref=${s.commit_sha}`).then(String);
  const pnpm = !s.lockfile.trimStart().startsWith('{');
  const lockName = pnpm ? 'pnpm-lock.yaml' : 'package-lock.json';

  let packageJson = await raw('package.json');
  for (const r of chosen) packageJson = editPackageJson(packageJson, r, pnpm);
  const actions: { action: 'update'; file_path: string; content: string }[] = [{ action: 'update', file_path: 'package.json', content: packageJson }];
  const fixes = chosen.map((r) => (r.ai?.status === 'done' ? r.ai.fix : null));
  const required = fixes.flatMap((f) => (f?.edits ?? []).filter((e: any) => e.required));
  for (const file of new Set<string>(required.map((e: any) => e.file))) {
    actions.push({ action: 'update', file_path: file, content: applyEdits(await raw(file), required.filter((e: any) => e.file === file)) });
  }
  const lock = await relock(packageJson, lockName, s.lockfile, pnpm ? await raw('pnpm-workspace.yaml').catch(() => null) : null);
  if (lock) actions.push({ action: 'update', file_path: lockName, content: lock });

  const one = chosen.length === 1 ? chosen[0] : null;
  const branch = one ? `depmap/fix-${one.name.replace(/[@/]/g, '-').replace(/^-/, '')}-${one.action!.version}` : `depmap/fix-all-${snapshotId}`;
  const left = pvs.filter((pv) => !chosen.some((r) => r.pv === pv));
  const optional = fixes.flatMap((f) => (f?.edits ?? []).filter((e: any) => !e.required));
  const changes = `Changes: \`package.json\`${required.length ? `, ${required.length} code change${required.length > 1 ? 's' : ''} written by the AI` : ''}${lock ? `, \`${lockName}\` regenerated` : ''}.`;
  const description = [
    ...(one ? [`**${one.action!.text}**`, '', ...one.why.map((w) => `- ${w}`)]
      : [`**Fixes ${chosen.length} risky packages found by DepthMap scan #${snapshotId}.**`, '', '| Package | Change | Why |', '|---|---|---|',
        ...chosen.map((r) => `| \`${r.name}\` | ${r.version} → ${r.action!.version}${r.direct ? '' : ' (override)'} | ${r.why[0]?.split(/\.\s/)[0].replace(/\|/g, '\\|') ?? ''} |`)]),
    '', changes,
    ...(lock ? [] : ['', `The lockfile could not be regenerated here; run \`${pnpm ? 'pnpm install' : 'npm install'}\` on this branch.`]),
    ...(left.length ? ['', `Not in this MR: ${left.map((pv) => `\`${pv}\``).join(', ')} (no fixed version; replace or accept by hand).`] : []),
    ...(optional.length ? ['', `<details><summary>${optional.length} optional code change${optional.length > 1 ? 's' : ''}, not applied</summary>`,
      ...optional.flatMap((e: any) => ['', `\`${e.file}:${e.startLine}\`: ${e.why}`, '```diff', ...e.before.split('\n').map((l: string) => `-${l}`), ...e.after.split('\n').map((l: string) => `+${l}`), '```']), '</details>'] : []),
    '', `Sources: ${chosen.flatMap((r) => r.sources.slice(0, one ? 8 : 1)).map((x) => `[${x.label}](${x.url})`).join(' · ')}`,
    '', `_Opened by DepthMap for ${by}._`,
  ].join('\n');

  let mr: any;
  try {
    await gl(`/projects/${project.id}/repository/commits`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch, start_sha: s.commit_sha, commit_message: one ? `depmap: ${one.action!.text.split(':')[0].replace(/\.$/, '')}` : `depmap: fix ${chosen.length} risky packages`, actions }) });
    mr = await gl(`/projects/${project.id}/merge_requests`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_branch: branch, target_branch: s.ref ?? project.default_branch, description, remove_source_branch: true,
        title: one ? `Fix ${one.pv}: ${one.action!.kind} ${one.name} to ${one.action!.version}` : `Fix ${chosen.length} risky packages (DepthMap)` }) });
  } catch (e) {
    // the branch exists from an earlier click: hand back its open merge request
    [mr] = await gl(`/projects/${project.id}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`);
    if (!mr) throw e;
  }
  for (const r of chosen) {
    await q("insert into decision (repo, pv, action, reason, by_user, mr_url) values ($1,$2,'fix',$3,$4,$5)", [s.repo, r.pv, `Fix merge request !${mr.iid}`, by, mr.web_url]);
  }
  await q('insert into event (kind, repo, payload) values ($1,$2,$3)', ['decision', s.repo, { action: 'fix', pvs: chosen.map((r) => r.pv), mrUrl: mr.web_url, by }]);
  return { mrUrl: mr.web_url as string, iid: mr.iid as number, lockfile: !!lock, codeChanges: required.length, fixed: chosen.map((r) => r.pv), left };
}
