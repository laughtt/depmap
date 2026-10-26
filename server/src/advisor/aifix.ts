import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import semver from 'semver';
import { z } from 'zod';
import { q } from '../db/db.ts';
import { knowledge, changelogBetween } from './knowledge.ts';
import { packument } from '../scanner/facts.ts';
import type { Remedy } from './remedy.ts';

export const AI_MODEL = process.env.AI_MODEL ?? 'claude-haiku-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
// $ per million tokens (input, output) for the cost line on each fix
const PRICE: Record<string, [number, number]> = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10], 'claude-opus-5-5': [4, 20] };

const Fix = z.object({
  needsCodeChange: z.boolean(),
  summary: z.string(),
  edits: z.array(z.object({ file: z.string(), startLine: z.number().int(), endLine: z.number().int(), before: z.string(), after: z.string(), why: z.string(), required: z.boolean() })),
  risks: z.array(z.string()),
  sources: z.array(z.object({ label: z.string(), url: z.string() })),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type AiFix = z.infer<typeof Fix> & { model: string; costUsd: number };

const SYSTEM = `You fix code that uses an npm package whose version must change for security reasons.
You get the package, the version change and why it is needed, the files of the repository that use the package (with line numbers), and evidence about the new version: its changelog, how its exports and module format changed, or the documented replacement.

Return the smallest set of edits that keeps the code working with the new version or the replacement:
- Each edit replaces lines startLine..endLine (1-based, inclusive) of one given file. "before" must be exactly those lines, copied character for character, joined with \\n. "after" is the new text for those lines.
- Change only what the version change or the replacement requires. Keep the code style. Do not touch package.json or lockfiles; that edit is handled separately.
- Mark an edit required when the code breaks without it. Also give recommended edits for APIs the new version deprecates, with required false.
- needsCodeChange is true only when at least one edit is required.
- Never invent APIs. When the evidence does not show how something changed, read the package's official migration guide or release notes with web_search and web_fetch (prefer the package's own docs and repository). If you still cannot confirm a change, say so in risks and lower the confidence instead of guessing.
- In "why", name the API change that forces the edit. Cite only URLs given in the evidence or pages you read.`;

const TOOLS: Anthropic.ToolUnion[] = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
  { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3 },
];

const numbered = (text: string) => text.split('\n').map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n');

// fixes that can break code: a direct dependency our sources use, moving across a breaking version or to another package
export function needsAi(r: Remedy) {
  if (!r.direct || !r.usedIn.length || !r.action) return false;
  if (r.action.kind === 'replace') return true;
  const to = r.action.version;
  if (!to || !semver.valid(to) || !semver.valid(r.version)) return false;
  return semver.major(to) !== semver.major(r.version) || (semver.major(to) === 0 && semver.minor(to) !== semver.minor(r.version));
}

// the files come from snapshot_file, which the scan fills with every file that imports a direct dependency
export async function queueAiFixes(snapshotId: number, remedies: Remedy[]) {
  if (!client) return;
  for (const r of remedies.filter(needsAi).sort((a, b) => b.color - a.color).slice(0, 10)) {
    const files = await q('select path, content from snapshot_file where snapshot_id = $1 and path = any($2) order by path', [snapshotId, [...new Set(r.usedIn.map((s) => s.file))]]);
    const key = createHash('sha256').update(JSON.stringify([AI_MODEL, r.pv, r.action, files])).digest('hex');
    await q('insert into ai_fix (snapshot_id, pv, key, remedy) values ($1,$2,$3,$4) on conflict do nothing', [snapshotId, r.pv, key, r]);
  }
}

async function evidence(r: Remedy) {
  const to = r.action?.version;
  const out: string[] = [], urls: { label: string; url: string }[] = [...r.sources];
  if (to) {
    const tgz = (v: string) => `https://registry.npmjs.org/${r.name}/-/${r.name.split('/').pop()}-${v}.tgz`;
    const [from, next] = await Promise.all([knowledge(r.name, r.version, tgz(r.version)), knowledge(r.name, to, tgz(to))]);
    if (from && next) {
      out.push(`Module format: ${r.version} is ${from.moduleFormat}, ${to} is ${next.moduleFormat}.`);
      const removed = Object.keys(from.named).filter((k) => !(k in next.named));
      const changed = Object.keys(from.named).filter((k) => k in next.named && from.named[k] !== next.named[k]);
      if (removed.length) out.push(`Exports removed in ${to}: ${removed.slice(0, 40).join(', ')}`);
      for (const k of changed.slice(0, 20)) out.push(`Signature changed: ${k}\n  ${r.version}: ${from.named[k].slice(0, 300)}\n  ${to}: ${next.named[k].slice(0, 300)}`);
      const log = changelogBetween(next.changelog, r.version, to);
      if (log) out.push(`Changelog ${r.version} → ${to}:\n${log.slice(0, 6000)}`);
    }
    urls.push({ label: `${r.name}@${to} on npm`, url: `https://www.npmjs.com/package/${r.name}/v/${to}` });
    const gh = (await packument(r.name))?.repository?.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (gh) urls.push({ label: `${r.name} release notes`, url: `https://github.com/${gh[1]}/${gh[2]}/releases` });
  }
  for (const a of r.alternatives.slice(0, 3)) out.push(`Replacement option ${a.name}: ${a.text}${a.example ? `\nExample:\n${a.example}` : ''}${a.url ? `\nDocs: ${a.url}` : ''}`);
  return { text: out.join('\n\n') || 'No changelog or type information was found for this version.', urls };
}

async function solve(r: Remedy, files: { path: string; content: string }[]) {
  const ev = await evidence(r);
  const task = `Package: ${r.name}
Change: ${r.action!.text}
Why it must change:
${r.why.map((w) => `- ${w}`).join('\n')}

Where the repository uses ${r.name}:
${r.usedIn.map((s) => `- ${s.file}:${s.line} ${s.code}${s.calls.length ? ` (then lines ${s.calls.map((c) => c.line).join(', ')})` : ''}`).join('\n')}

Evidence:
${ev.text}

Allowed source URLs:
${ev.urls.map((u) => `- ${u.label}: ${u.url}`).join('\n')}

Files:
${files.map((f) => `=== ${f.path}\n${numbered(f.content)}`).join('\n\n')}`;
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task }];
  const usage = { input: 0, output: 0, searches: 0 };
  const read = new Set(ev.urls.map((u) => u.url));
  for (let attempt = 0, turns = 0; attempt < 2 && turns < 6; turns++) {
    const res = await client!.messages.parse({
      model: AI_MODEL, max_tokens: 16000, system: SYSTEM, messages, tools: TOOLS,
      output_config: { format: zodOutputFormat(Fix), effort: 'medium' },
    });
    usage.input += res.usage.input_tokens; usage.output += res.usage.output_tokens; usage.searches += res.usage.server_tool_use?.web_search_requests ?? 0;
    for (const b of res.content as any[]) {
      if (b.type === 'web_fetch_tool_result' && b.content?.url) read.add(b.content.url);
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach((x: any) => x.url && read.add(x.url));
    }
    // a server tool loop that ran long pauses; send the turn back to let it finish
    if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
    if (res.stop_reason === 'refusal') throw new Error('the model declined this request');
    const fix = res.parsed_output;
    if (!fix) throw new Error(`no structured output (stop: ${res.stop_reason})`);
    const errors = fix.edits.flatMap((e) => {
      const f = files.find((x) => x.path === e.file);
      if (!f) return [`${e.file} is not one of the given files`];
      const actual = f.content.split('\n').slice(e.startLine - 1, e.endLine).join('\n');
      return actual.trimEnd() === e.before.trimEnd() ? [] : [`${e.file}:${e.startLine}-${e.endLine}: "before" does not match the file. The file has:\n${actual}`];
    });
    if (!errors.length) {
      const [pin, pout] = PRICE[AI_MODEL] ?? [0, 0];
      return { fix: { ...fix, sources: fix.sources.filter((s) => read.has(s.url)), model: AI_MODEL, costUsd: (usage.input * pin + usage.output * pout) / 1e6 + usage.searches * 0.01 }, usage };
    }
    attempt++;
    messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: `Fix these edits and return the full answer again:\n${errors.join('\n')}` });
  }
  throw new Error('the suggested edits did not match the files twice');
}

async function work() {
  const jobs = await q(`update ai_fix set status = 'running', updated_at = now() where (snapshot_id, pv) in (
    select snapshot_id, pv from ai_fix where status = 'queued' order by created_at limit 2 for update skip locked) returning *`);
  await Promise.all(jobs.map(async (j) => {
    try {
      const [done] = await q("select result, usage from ai_fix where key = $1 and status = 'done' limit 1", [j.key]);
      const out = done ? { fix: done.result, usage: { ...done.usage, reused: true } }
        : await solve(j.remedy, await q('select path, content from snapshot_file where snapshot_id = $1 and path = any($2)', [j.snapshot_id, [...new Set(j.remedy.usedIn.map((s: any) => s.file))]]));
      await q("update ai_fix set status = 'done', result = $3, usage = $4, updated_at = now() where snapshot_id = $1 and pv = $2", [j.snapshot_id, j.pv, out.fix, out.usage]);
    } catch (e) {
      await q("update ai_fix set status = 'failed', error = $3, updated_at = now() where snapshot_id = $1 and pv = $2", [j.snapshot_id, j.pv, (e as Error).message]);
    }
  }));
  return jobs.length;
}

// runs inside the API process; a crash mid-job leaves the row 'running', so those are re-queued on start
export async function startAiWorker() {
  if (!client) return console.log('AI fixes off (no ANTHROPIC_API_KEY)');
  await q("update ai_fix set status = 'queued' where status = 'running'");
  console.log(`AI fixes on (${AI_MODEL})`);
  const loop = async () => {
    const n = await work().catch((e) => (console.error('ai worker', e), 0));
    setTimeout(loop, n ? 0 : 2000);
  };
  loop();
}
