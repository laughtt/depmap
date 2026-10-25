import semver from 'semver';
import { cachedJson, mapLimit } from './http.ts';

const REGISTRY = process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org';
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

export type VersionDoc = { publisher?: string; maintainers: string[]; scripts: string[]; provenance: boolean; deprecated?: string; license?: string; tarball?: string };
export type Packument = { name: string; time: Record<string, string>; versions: Record<string, VersionDoc>; latest?: string; repository?: string };

// full packuments can be tens of MB; keep only what the rules need so fixtures stay small
function trim(doc: any): Packument {
  const versions: Record<string, VersionDoc> = {};
  for (const [v, m] of Object.entries<any>(doc.versions ?? {})) {
    versions[v] = {
      publisher: m._npmUser?.name,
      maintainers: (m.maintainers ?? []).map((x: any) => x.name ?? String(x)),
      scripts: INSTALL_SCRIPTS.filter((s) => m.scripts?.[s]),
      provenance: !!m.dist?.attestations?.provenance,
      deprecated: m.deprecated || undefined,
      license: typeof m.license === 'string' ? m.license : m.license?.type,
      tarball: m.dist?.tarball,
    };
  }
  const repo = doc.repository;
  return { name: doc.name, time: doc.time ?? {}, versions, latest: doc['dist-tags']?.latest, repository: typeof repo === 'string' ? repo : repo?.url };
}

export function packument(name: string): Promise<Packument | null> {
  return cachedJson(`${REGISTRY}/${name.replace('/', '%2f')}`, { transform: trim });
}

export async function packuments(names: string[]) {
  const docs = await mapLimit(names, 12, packument);
  return new Map(names.map((n, i) => [n, docs[i]]));
}

export async function weeklyDownloads(names: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const plain = names.filter((n) => !n.startsWith('@')).sort();
  const scoped = names.filter((n) => n.startsWith('@'));
  for (let i = 0; i < plain.length; i += 128) {
    const chunk = plain.slice(i, i + 128);
    const data = await cachedJson(`https://api.npmjs.org/downloads/point/last-week/${chunk.join(',')}`);
    if (chunk.length === 1 && data?.downloads !== undefined) out.set(chunk[0], data.downloads);
    else for (const n of chunk) if (data?.[n]?.downloads !== undefined) out.set(n, data[n].downloads);
  }
  await mapLimit(scoped, 8, async (n) => {
    const data = await cachedJson(`https://api.npmjs.org/downloads/point/last-week/${n}`);
    if (data?.downloads !== undefined) out.set(n, data.downloads);
  });
  return out;
}

export type VersionFacts = {
  publishedAt?: string;
  publisher?: string;
  maintainers: string[];
  installScripts: string[];
  provenance: boolean;
  deprecated?: string;
  license?: string;
  unpublished: boolean;
  previous?: { version: string; publisher?: string; maintainers: string[]; provenance: boolean; installScripts: string[] };
  weeklyDownloads?: number;
  tarball?: string;
  latest?: string;
};

export function versionFacts(doc: Packument | null, version: string, downloads?: number): VersionFacts | null {
  if (!doc) return null;
  const v = doc.versions[version];
  const publishedAt = doc.time[version];
  if (!v && !publishedAt) return null;
  // the previous release on the same major line; publish order alone would compare 1.x patches with 2.0 betas
  const earlier = Object.keys(doc.versions).filter((x) => x !== version && doc.time[x] && (!publishedAt || doc.time[x] < publishedAt));
  const sameLine = semver.valid(version) ? earlier.filter((x) => semver.valid(x) && semver.major(x) === semver.major(version) && semver.lt(x, version)) : [];
  const prevVersion = sameLine.length
    ? sameLine.sort(semver.compare).at(-1)
    : earlier.sort((a, b) => doc.time[a].localeCompare(doc.time[b])).at(-1);
  const p = prevVersion ? doc.versions[prevVersion] : undefined;
  return {
    publishedAt,
    publisher: v?.publisher,
    maintainers: v?.maintainers ?? [],
    installScripts: v?.scripts ?? [],
    provenance: v?.provenance ?? false,
    deprecated: v?.deprecated,
    license: v?.license,
    unpublished: !v,
    previous: p && prevVersion ? { version: prevVersion, publisher: p.publisher, maintainers: p.maintainers, provenance: p.provenance, installScripts: p.scripts } : undefined,
    weeklyDownloads: downloads,
    tarball: v?.tarball,
    latest: doc.latest,
  };
}
