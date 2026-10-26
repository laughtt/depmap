// Scheduled pipeline: poll the watchers, re-assess every repo with today's advisories, open an issue per package that turned red.
import { env, depmap, gitlab } from './depmap-lib.mjs';

await depmap('/api/watchers/poll', {}).catch((e) => console.log(`depmap refresh: watcher poll failed (${e.message}), continuing`));
const { flipped } = await depmap('/api/refresh', env.DEPMAP_AS_OF ? { asOf: env.DEPMAP_AS_OF } : {});
const reds = flipped.filter((f) => f.to === 2);
const projects = await gitlab('/projects?membership=true&per_page=100');
const latest = new Map();
for (const repo of new Set(reds.flatMap((f) => f.repos))) {
  const snaps = await depmap(`/api/repos/${encodeURIComponent(repo)}/snapshots`);
  latest.set(repo, (snaps.findLast((s) => s.kind === 'refresh') ?? snaps.at(-1)).id);
}
let opened = 0;

for (const f of reds) {
  const title = `depmap: ${f.pv} turned red`;
  for (const repo of f.repos) {
    const project = projects.find((p) => p.path_with_namespace === repo);
    if (!project) {
      console.log(`depmap refresh: ${repo} is not a project of this token, skipping ${f.pv}`);
      continue;
    }
    const existing = await gitlab(`/projects/${project.id}/issues?state=opened&labels=security::watch&search=${encodeURIComponent(title)}`);
    if (existing.some((i) => i.title === title)) {
      console.log(`depmap refresh: ${repo} already has "${title}"`);
      continue;
    }
    const d = await depmap(`/api/pv?pv=${encodeURIComponent(f.pv)}&snapshot=${latest.get(repo)}`);
    const fix = d.advisories?.flatMap((a) => a.fixed ?? [])[0] ?? d.reasons.map((r) => r.text.match(/Fixed in ([\w.+-]+?)\.?$/)?.[1]).find(Boolean);
    const name = f.pv.replace(/@[^@]*$/, '');
    const description = [
      `\`${f.pv}\` was ${['green', 'amber', 'red', 'grey'][f.from]} and is now **red** in \`${repo}\`; nothing in this repository changed, the world did.`,
      '', '**Why**', '',
      ...d.reasons.map((r) => `- ${r.text} ([${r.code}](${r.url}))`),
      ...(d.fingerprint ? [`- Looks like **${d.fingerprint.title}**: ${d.fingerprint.matched} of ${d.fingerprint.total} signals ([background](${d.fingerprint.url}))`] : []),
      '', '**Suggested fix**', '',
      fix ? `Move \`${name}\` to **${fix}** (an \`overrides\` entry in package.json works for transitive packages), or record a decision in the next MR.` : 'No fixed version is published yet: pin the previous version or record a time-boxed decision.',
      '', `Also affected: ${f.repos.map((x) => `\`${x}\``).join(', ')} · [map](${env.DEPMAP_APP_URL ?? env.DEPMAP_API_URL ?? 'http://localhost:8787'}/repos/${repo}/map/${latest.get(repo)})`,
      '', '<sub>Opened by the depmap scheduled refresh · 0 GitLab credits</sub>',
    ].join('\n');
    const issue = await gitlab(`/projects/${project.id}/issues`, { method: 'POST', body: { title, description, labels: 'security::watch' } });
    opened++;
    console.log(`depmap refresh: opened ${repo}#${issue.iid} "${title}"`);
  }
}
console.log(`depmap refresh: ${flipped.length} colour change(s), ${reds.length} new red, ${opened} issue(s) opened`);
