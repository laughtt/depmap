import { q } from '../db/db.ts';
import { cachedDerived, cachedJson } from '../scanner/http.ts';

// Where supply-chain incidents get posted first, often hours before an advisory database has a record.
export const WATCHERS = [
  { id: 'github-malware', name: 'GitHub malware advisories', kind: 'ghsa', url: 'https://api.github.com/advisories?ecosystem=npm&type=malware&per_page=100' },
  { id: 'aikido', name: 'Aikido Security research', kind: 'rss', url: 'https://www.aikido.dev/blog/rss.xml' },
  { id: 'stepsecurity', name: 'StepSecurity blog', kind: 'rss', url: 'https://www.stepsecurity.io/blog/rss.xml' },
  { id: 'wiz', name: 'Wiz research', kind: 'rss', url: 'https://www.wiz.io/feed/rss.xml' },
  { id: 'snyk', name: 'Snyk blog', kind: 'rss', url: 'https://snyk.io/blog/feed/' },
  { id: 'openssf', name: 'OpenSSF blog', kind: 'rss', url: 'https://openssf.org/feed/' },
  { id: 'cisa', name: 'CISA advisories', kind: 'rss', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
] as const;

export type WatchItem = { id: string; source: string; title: string; url: string; published: string; summary: string; packages: { name: string; versions: string[] }[] };

const tag = (x: string, t: string) => x.match(new RegExp(`<${t}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`))?.[1]?.trim() ?? '';
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();

// date-only feeds (midnight timestamps) are treated as published at the end of that day, so a replay never "knows" early
function publishedAt(raw: string) {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const dateOnly = /\b00:00:00\b/.test(raw) || (d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && [0, 4, 5, 7, 8].includes(d.getUTCHours()));
  return dateOnly ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59)).toISOString() : d.toISOString();
}

function parseRss(xml: string, source: string): WatchItem[] {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].flatMap(([, x]) => {
    const published = publishedAt(tag(x, 'pubDate'));
    const url = tag(x, 'link');
    if (!published || !url || published < '2025-01-01') return [];
    return [{ id: `${source}:${url}`, source, title: text(tag(x, 'title')), url, published, summary: text(tag(x, 'description')).slice(0, 1000), packages: [] }];
  });
}

function parseGhsa(list: any[], source: string): WatchItem[] {
  return (list ?? []).map((a) => ({
    id: `${source}:${a.ghsa_id}`, source, title: a.summary, url: a.html_url, published: a.published_at, summary: (a.description ?? '').slice(0, 1000),
    packages: (a.vulnerabilities ?? []).filter((v: any) => v.package?.ecosystem === 'npm').map((v: any) => ({ name: v.package.name, versions: [v.vulnerable_version_range].filter(Boolean) })),
  }));
}

export async function pollWatchers(opts: { fresh?: boolean } = {}) {
  const results = [];
  for (const w of WATCHERS) {
    try {
      const items: WatchItem[] = w.kind === 'ghsa'
        ? parseGhsa(await cachedJson(w.url), w.id)
        : (await cachedDerived(`watch ${w.url}`, async () => {
            const res = await fetch(w.url, { headers: { 'user-agent': 'depmap-watcher/1.0' } });
            return res.ok ? parseRss(await res.text(), w.id) : null;
          }, opts.fresh)) ?? [];
      for (const it of items) {
        await q(`insert into watch_item (id, source, title, url, published, summary, packages) values ($1,$2,$3,$4,$5,$6,$7)
                 on conflict (id) do update set title = excluded.title, summary = excluded.summary, packages = excluded.packages`,
          [it.id, it.source, it.title, it.url, it.published, it.summary, JSON.stringify(it.packages)]);
      }
      results.push({ id: w.id, name: w.name, items: items.length, ok: true });
    } catch (e: any) {
      results.push({ id: w.id, name: w.name, items: 0, ok: false, error: e.message });
    }
  }
  await q('insert into event (kind, payload) values ($1,$2)', ['watch-poll', { sources: results }]);
  return results;
}

const SUPPLY_CHAIN = /\b(npm|package|supply.chain|compromis|malicious|malware|worm|hijack|backdoor|typosquat)/i;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// many package names are ordinary words (send, fresh, vary); free text only counts when the post's title is about a
// supply-chain incident and names the package, or the body names it unambiguously (name@1.2.3, "the name package")
export function namesPackage(item: { title: string; summary: string; packages?: { name: string }[] }, name: string) {
  if (item.packages?.length) return item.packages.some((p) => p.name === name);
  const n = escapeRe(name);
  const titleTokens = new Set(item.title.toLowerCase().split(/[^a-z0-9@/._-]+/).map((t) => t.replace(/[.,]+$/, '')));
  if (titleTokens.has(name.toLowerCase()) && SUPPLY_CHAIN.test(item.title)) return true;
  return new RegExp(`(?:^|[^\\w@/-])${n}@\\d|\\b(?:the|npm)\\s+[\`'"]?${n}[\`'"]?\\s+(?:package|library|module)|\\bpackages?\\s+(?:named\\s+)?[\`'"]?${n}\\b`, 'i').test(item.summary);
}

export type Mention = { item: Pick<WatchItem, 'id' | 'source' | 'title' | 'url' | 'published'>; exact: boolean };

// a package counts as mentioned when a supply-chain post names it as a whole word; short names are too ambiguous
export async function mentionsFor(nodes: { name: string; version: string; pv: string }[], asOf: string): Promise<Map<string, Mention[]>> {
  const items = await q("select * from watch_item where published <= $1 and published > $1::timestamptz - interval '7 days'", [asOf]);
  const out = new Map<string, Mention[]>();
  if (!items.length) return out;
  const byName = new Map<string, typeof nodes>();
  for (const n of nodes) if (n.name.length >= 4) (byName.get(n.name) ?? byName.set(n.name, []).get(n.name)!).push(n);
  for (const it of items) {
    if (!it.packages?.length && !SUPPLY_CHAIN.test(`${it.title} ${it.summary}`)) continue;
    const structured = new Map<string, string[]>((it.packages ?? []).map((p: any) => [p.name, p.versions]));
    for (const [name, list] of byName) {
      if (!namesPackage(it, name)) continue;
      for (const n of list) {
        const exact = new RegExp(`(?:^|[^\\w@/-])${escapeRe(n.pv)}(?![\\w.])`, 'i').test(`${it.title} ${it.summary}`)
          || (structured.get(name) ?? []).some((r) => r.split(/,\s*/).some((c) => c.trim() === `= ${n.version}` || c.trim() === n.version));
        const m = out.get(n.pv) ?? out.set(n.pv, []).get(n.pv)!;
        m.push({ item: { id: it.id, source: it.source, title: it.title, url: it.url, published: new Date(it.published).toISOString() }, exact });
      }
    }
  }
  return out;
}
