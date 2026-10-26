import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// live: always fetch; record: read fixture, else fetch and save; replay: fixtures only (tests, offline demo)
const MODE = process.env.DATA_MODE ?? 'record';
const DIR = process.env.FIXTURES_DIR ?? new URL('../../../fixtures/http/', import.meta.url).pathname;
// reads also fall back to the git-ignored scans of private repos, so a refresh keeps their recorded advisories
const READ_DIRS = [...new Set([DIR, new URL('../../../fixtures/local/', import.meta.url).pathname])];

async function readFixture(name: string) {
  for (const dir of READ_DIRS) {
    try {
      return JSON.parse(await readFile(join(dir, name), 'utf8')).data;
    } catch {}
  }
  throw new Error('no fixture');
}

type Opts = { method?: string; body?: unknown; transform?: (json: any) => any };

// network work per scan, for the SCI receipt
export const stats = { fetches: 0, cacheHits: 0, bytes: 0 };

export async function cachedJson(url: string, opts: Opts = {}): Promise<any> {
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const key = createHash('sha256').update(`${opts.method ?? 'GET'} ${url} ${body ?? ''}`).digest('hex').slice(0, 32);
  const file = join(DIR, `${key}.json`);
  if (MODE !== 'live') {
    try {
      const hit = await readFixture(`${key}.json`);
      stats.cacheHits++;
      return hit;
    } catch {
      if (MODE === 'replay') return null;
    }
  }
  stats.fetches++;
  const res = await fetchRetry(url, { method: opts.method ?? 'GET', body, headers: body ? { 'content-type': 'application/json' } : {} });
  const raw = res.ok ? await res.text() : '';
  stats.bytes += raw.length;
  const data = res.ok ? (opts.transform ?? ((x: any) => x))(JSON.parse(raw)) : null;
  if (MODE !== 'live' && (res.ok || res.status === 404)) {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ url, status: res.status, data }));
  }
  return data;
}

// for results derived from non-JSON downloads (tarballs): the derived JSON is the fixture
export async function cachedDerived<T>(key: string, compute: () => Promise<T>, fresh = false): Promise<T | null> {
  const name = `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`;
  const file = join(DIR, name);
  if (MODE !== 'live' && !(fresh && MODE !== 'replay')) {
    try {
      return await readFixture(name);
    } catch {
      if (MODE === 'replay') return null;
    }
  }
  const data = await compute();
  if (MODE !== 'live' && data !== null) {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, JSON.stringify({ key, data }));
  }
  return data;
}

async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500 && res.status !== 429) return res;
      if (i >= tries) return res;
    } catch (e) {
      if (i >= tries) throw e;
    }
    await new Promise((r) => setTimeout(r, 300 * i * i));
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}
