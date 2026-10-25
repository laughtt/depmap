import semver from 'semver';
import { q } from '../db/db.ts';
import { findUsage, type Usage } from './usage.ts';
import { knowledge, changelogBetween, type Knowledge } from './knowledge.ts';

export type AdviceItem = { file: string; line: number; code: string; problem: string; fix: string; alternatives: string[] };
export type Advice = {
  package: string; from: string; to: string; direct: boolean;
  verdict: 'NEEDS_CHANGE' | 'REVIEW' | 'NO_CHANGE' | 'PATH_ONLY';
  summary: string; items: AdviceItem[];
  evidence: { kind: string; text: string; url?: string }[];
  paths: string[][];
};

type Input = { name: string; from: string; to: string; direct: boolean; paths: string[][]; sources: { path: string; content: string }[]; packageJson?: string };

async function tarballOf(name: string, version: string) {
  const [row] = await q("select facts->>'tarball' as t from package_version where pv = $1", [`${name}@${version}`]);
  return row?.t ?? `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
}

// the API surface our import style actually sees
function surface(k: Knowledge, site: Usage, requireOfEsm: boolean) {
  if (requireOfEsm) return k.named; // require(esm) returns the namespace object, not the default export
  if (site.style === 'named') return k.exportStyle === 'export=' ? k.members : k.named;
  return k.exportStyle === 'named' ? k.named : k.members;
}

export async function adviseUpgrade(input: Input): Promise<Advice> {
  const { name, from, to } = input;
  const base = { package: name, from, to, direct: input.direct, paths: input.paths, items: [] as AdviceItem[], evidence: [] as Advice['evidence'] };
  if (!input.direct) {
    const via = input.paths[0]?.join(' → ') ?? name;
    return { ...base, verdict: 'PATH_ONLY', summary: `No code change: your code does not import ${name}; it reaches you via ${via}.` };
  }
  const usage = findUsage(input.sources, name);
  const [kf, kt] = await Promise.all([knowledge(name, from, await tarballOf(name, from)), knowledge(name, to, await tarballOf(name, to))]);
  const major = semver.valid(from) && semver.valid(to) && semver.major(to) > semver.major(from);
  const engines = input.packageJson ? JSON.parse(input.packageJson).engines?.node : undefined;
  const npm = (v: string) => `https://www.npmjs.com/package/${name}/v/${v}`;
  if (major) base.evidence.push({ kind: 'semver_major', text: `Major version bump ${from} → ${to}.`, url: npm(to) });
  const log = changelogBetween(kt?.changelog, from, to);
  if (log) base.evidence.push({ kind: 'changelog', text: log.split('\n').filter((l) => /break|remov|renam|drop|require|esm/i.test(l)).slice(0, 6).join('\n') || log.slice(0, 400) });

  if (!usage.length) {
    return { ...base, verdict: 'NO_CHANGE', summary: `${name} is a direct dependency but no source file imports it (CLI, config or runtime use); nothing to change in code.` };
  }

  const esmBreak = kt?.moduleFormat === 'esm-only' && kf?.moduleFormat !== 'esm-only';
  if (esmBreak) base.evidence.push({ kind: 'module_format', text: `${name}@${to} is ESM-only ("type": "module", no "require" export); ${from} was ${kf?.moduleFormat ?? 'CommonJS'}.`, url: npm(to) });

  for (const site of usage) {
    const requireOfEsm = esmBreak && site.kind === 'require';
    if (requireOfEsm) {
      const oldNode = engines && !semver.subset(engines, '>=20.19.0');
      const lost = site.symbols.filter((s) => kt && !(s.name in kt.named));
      base.items.push({
        file: site.file, line: site.line, code: site.code,
        problem: oldNode
          ? `require('${name}') throws ERR_REQUIRE_ESM on Node versions your engines field allows (${engines}).`
            + (lost.length ? ` On Node ≥ 20.19, require() returns the module namespace, so ${lost.map((s) => `${site.binding ?? name}.${s.name === '()' ? '' : s.name}`).join(', ')} would be undefined.` : '')
          : `require() of an ES module returns its namespace; ${lost.map((s) => s.name).join(', ')} live on the default export.`,
        fix: site.binding ? `import ${site.binding} from '${name}';  // and make this file ESM ("type": "module" or .mjs)` : `import * as ${name.replace(/\W/g, '')} from '${name}';`,
        alternatives: [
          `Stay on ${name}@${semver.major(from)}.x (CommonJS) until the file moves to ESM.`,
          `const { default: ${site.binding ?? 'mod'} } = await import('${name}');  // inside an async function`,
          ...(name === 'chalk' ? ["Drop the dependency: Node's util.styleText (Node ≥ 20.12) covers basic colours."] : []),
        ],
      });
      continue;
    }
    if (!kf?.hasTypes || !kt?.hasTypes) continue;
    const before = surface(kf, site, false);
    const after = surface(kt, site, false);
    for (const s of site.symbols) {
      if (s.name in before && !(s.name in after)) {
        base.items.push({ file: site.file, line: s.line, code: s.code, problem: `\`${s.name}\` no longer exists in ${name}@${to}.`, fix: `Replace \`${s.name}\`; see the ${to} release notes.`, alternatives: [`Stay on ${name}@${from}.`] });
        base.evidence.push({ kind: 'export_removed', text: `${s.name}: ${before[s.name]}` });
      } else if (s.name in before && before[s.name] !== after[s.name]) {
        base.evidence.push({ kind: 'signature_changed', text: `${s.name}: ${before[s.name]}  →  ${after[s.name]}` });
      }
    }
  }

  const used = [...new Set(usage.flatMap((u) => u.symbols.map((s) => s.name)))].filter((s) => s !== '()');
  const sites = usage.length > 1 ? `${usage.length} import sites use` : '1 import site uses';
  if (base.items.length) {
    return { ...base, verdict: 'NEEDS_CHANGE', summary: esmBreak
      ? `${name} ${semver.major(to)} is ESM-only; ${base.items.length} require() call site${base.items.length > 1 ? 's' : ''} must change.`
      : `${base.items.length} use${base.items.length > 1 ? 's' : ''} of removed API in ${name}@${to}.` };
  }
  if (base.evidence.some((e) => e.kind === 'signature_changed') || (major && !(kf?.hasTypes && kt?.hasTypes))) {
    return { ...base, verdict: 'REVIEW', summary: `${sites} ${used.join(', ') || name}; ${major ? 'a major bump' : 'changed signatures'} without a provable break. Run the tests and read the evidence.` };
  }
  return { ...base, verdict: 'NO_CHANGE', summary: `${sites} ${used.length ? used.join(', ') : 'the default export'}; ${kt?.hasTypes ? 'none of it changed between versions' : `semver ${from} → ${to} promises compatibility`}.` };
}
