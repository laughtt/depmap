import { readFile } from 'node:fs/promises';
import semver from 'semver';
import { cachedJson, mapLimit } from './http.ts';

export type Advisory = {
  id: string;
  kind: 'malicious' | 'vuln';
  summary: string;
  severity: 'CRITICAL' | 'HIGH' | 'MODERATE' | 'LOW' | 'UNKNOWN';
  published: string;
  fixed: string[];
  url: string;
};

const SEVERITIES = ['CRITICAL', 'HIGH', 'MODERATE', 'LOW'];

function toAdvisory(v: any, name: string): Advisory {
  const kind = v.id.startsWith('MAL-') ? 'malicious' : 'vuln';
  const sev = String(v.database_specific?.severity ?? '').toUpperCase();
  const fixed = (v.affected ?? [])
    .filter((a: any) => a.package?.name === name)
    .flatMap((a: any) => (a.ranges ?? []).flatMap((r: any) => r.events.filter((e: any) => e.fixed).map((e: any) => e.fixed)));
  return {
    id: v.id,
    kind,
    summary: v.summary ?? v.details?.slice(0, 160) ?? '',
    severity: kind === 'malicious' ? 'CRITICAL' : SEVERITIES.includes(sev) ? (sev as Advisory['severity']) : 'UNKNOWN',
    published: v.published,
    fixed,
    url: `https://osv.dev/vulnerability/${v.id}`,
  };
}

// a local OSV-format feed stands in for advisories published after the fixtures were recorded
async function localFeed(): Promise<any[]> {
  const file = process.env.ADVISORY_FEED;
  if (!file) return [];
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

// advisories are filtered by their publish date, so a replay "as of" a past moment sees only what was public then
export async function advisoriesFor(pvs: { name: string; version: string }[], asOf: string): Promise<Map<string, Advisory[]>> {
  const out = new Map<string, Advisory[]>();
  const ids = new Map<string, Set<string>>();
  for (let i = 0; i < pvs.length; i += 1000) {
    const chunk = pvs.slice(i, i + 1000);
    const res = await cachedJson('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      body: { queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })) },
    });
    chunk.forEach((p, j) => {
      const vulns: any[] = res?.results?.[j]?.vulns ?? [];
      if (vulns.length) ids.set(`${p.name}@${p.version}`, new Set(vulns.map((v) => v.id)));
    });
  }
  const unique = [...new Set([...ids.values()].flatMap((s) => [...s]))];
  const details = new Map<string, any>();
  await mapLimit(unique, 8, async (id) => details.set(id, await cachedJson(`https://api.osv.dev/v1/vulns/${id}`)));

  for (const [pv, set] of ids) {
    const name = pv.slice(0, pv.lastIndexOf('@'));
    const list = [...set].map((id) => details.get(id)).filter(Boolean).map((v) => toAdvisory(v, name));
    out.set(pv, list);
  }
  for (const v of await localFeed()) {
    for (const a of v.affected ?? []) {
      for (const version of a.versions ?? []) {
        const pv = `${a.package.name}@${version}`;
        const list = out.get(pv) ?? [];
        if (!list.some((x) => x.id === v.id)) list.push(toAdvisory(v, a.package.name));
        out.set(pv, list);
      }
    }
  }
  for (const [pv, list] of out) out.set(pv, list.filter((a) => !a.published || a.published <= asOf));
  return out;
}

export type AdvisoryDetail = {
  id: string; cwe: string[]; affected: string[]; fixedIn: { version: string; bump: string } | null;
  sections: { title: string; blocks: { text?: string; code?: string }[] }[]; fixLinks: string[];
};

// GitHub-reviewed records write details as "### Impact / Patches / Workarounds / PoC" markdown; keep prose and fenced code apart
function sections(md: string) {
  const out: AdvisoryDetail['sections'] = [];
  md = md.replace(/^(-{3,}|_?-=.*=-_?)\s*$/gm, '');
  for (const [k, part] of md.split(/^#{2,4}\s+/m).entries()) {
    const [title, ...rest] = k === 0 ? ['Details', part] : part.split('\n');
    const blocks = rest.join('\n').split(/^```[\w-]*\n?/m).map((s, i) => (i % 2 ? { code: s.replace(/\n$/, '') } : { text: s.trim() })).filter((b) => b.code ?? b.text);
    if (/^references$/i.test(title.trim()) || !blocks.length) continue;
    // malware records put their cleanup advice under a "Source: ghsa-malware (hash)" heading
    out.push({ title: /^source:/i.test(title.trim()) ? 'What to do' : title.trim(), blocks });
  }
  return out;
}

export async function advisoryDetail(id: string, name: string, version: string): Promise<AdvisoryDetail | null> {
  const v = (await localFeed()).find((x) => x.id === id) ?? (await cachedJson(`https://api.osv.dev/v1/vulns/${id}`).catch(() => null));
  if (!v) return null;
  const ranges = (v.affected ?? []).filter((a: any) => a.package?.name === name).flatMap((a: any) => a.ranges ?? []);
  const affected: string[] = [], fixes: string[] = [];
  for (const r of ranges) {
    let from = '0';
    for (const e of r.events) {
      if (e.introduced) from = e.introduced;
      const to = e.fixed ?? e.last_affected;
      if (!to) continue;
      affected.push(`>=${from} ${e.fixed ? '<' : '<='}${to}`);
      if (e.fixed && semver.valid(e.fixed) && semver.gt(e.fixed, version) && semver.gte(version, semver.valid(from) ?? '0.0.0')) fixes.push(e.fixed);
    }
    if (r.events.every((e: any) => !e.fixed && !e.last_affected)) affected.push(`>=${from}`);
  }
  const fix = fixes.sort(semver.compare)[0];
  return {
    id, cwe: v.database_specific?.cwe_ids ?? [], affected,
    fixedIn: fix ? { version: fix, bump: semver.diff(version, fix) ?? 'patch' } : null,
    sections: sections(v.details ?? ''),
    fixLinks: (v.references ?? []).map((r: any) => r.url).filter((u: string) => /\/(commit|pull|releases\/tag)\//.test(u)),
  };
}
