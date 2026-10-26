// Keep feeding the world map: scan public repos' lockfiles, then follow every new package to its own repo.
// usage: node scripts/crawl.ts [--once] [--pause 15000]    (Ctrl-C stops after the current repo)
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

process.env.DATA_MODE ??= 'record';
process.env.FIXTURES_DIR ??= new URL('../fixtures/crawl/', import.meta.url).pathname;
const { migrate, pool, q } = await import('../server/src/db/db.ts');
const { scan } = await import('../server/src/scanner/scan.ts');
const { parseLockfile } = await import('../server/src/scanner/lockfile.ts');
const { packument } = await import('../server/src/scanner/facts.ts');

// popular JS projects that commit an npm or pnpm lockfile at the root
const SEEDS = [
  'vercel/next.js', 'vuejs/core', 'vitejs/vite', 'sveltejs/svelte', 'withastro/astro', 'nuxt/nuxt', 'remix-run/react-router', 'prisma/prisma',
  'microsoft/vscode', 'microsoft/TypeScript', 'nestjs/nest', 'supabase/supabase', 'n8n-io/n8n', 'mermaid-js/mermaid', 'angular/angular',
  'tailwindlabs/tailwindcss', 'shadcn-ui/ui', 'trpc/trpc', 'TanStack/query', 'vercel/ai', 'drizzle-team/drizzle-orm', 'payloadcms/payload',
  'directus/directus', 'discourse/discourse', 'honojs/hono', 'fastify/fastify', 'expressjs/express', 'webpack/webpack', 'rollup/rollup',
  'eslint/eslint', 'prettier/prettier', 'vitest-dev/vitest', 'jestjs/jest', 'mui/material-ui', 'chakra-ui/chakra-ui', 'excalidraw/excalidraw',
  'mastodon/mastodon', 'gitlabhq/gitlabhq', 'grafana/grafana', 'immich-app/immich', 'outline/outline', 'umami-software/umami', 'nodejs/node',
];
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json'];
const MAX_LOCK_BYTES = 20e6;

const { values } = parseArgs({ options: { once: { type: 'boolean' }, pause: { type: 'string', default: '15000' } } });
let stopping = false;
process.on('SIGINT', () => { stopping = true; console.log('stopping after the current repo…'); });

// "git+https://github.com/a/b.git", "github:a/b", "a/b" → "a/b"
function githubRepo(url?: string) {
  const m = url?.match(/^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/) ?? url?.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function fetchLockfile(repo: string) {
  for (const file of LOCKFILES) {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/${file}`, { signal: AbortSignal.timeout(60_000) });
    if (r.ok && Number(r.headers.get('content-length') ?? 0) <= MAX_LOCK_BYTES) return { file, text: await r.text() };
    if (r.status === 429) throw new Error('GitHub rate limit');
  }
  return null;
}

async function next() {
  const [row] = await q(`select * from crawl_queue
    where status = 'pending' or (status = 'done' and tried_at < now() - interval '7 days') or (status = 'error' and tried_at < now() - interval '1 day')
    order by status = 'pending' desc, source = 'seed' desc, hits desc, added_at limit 1`);
  return row;
}

async function crawl(repo: string, known: string | null) {
  const lock = await fetchLockfile(repo);
  if (!lock) return { status: 'nolock' };
  const sha = createHash('sha256').update(lock.text).digest('hex');
  if (sha === known) return { status: 'done', sha, note: 'unchanged' };
  const g = parseLockfile(lock.text);
  const r = await scan({ repo: `gh/${repo}`, ref: 'HEAD', commitSha: `crawl-${sha.slice(0, 12)}`, kind: 'crawl', lockfile: lock.text });
  // the rabbit hole: every package points at its own repo; packuments are already cached by the scan
  const names = [...new Set(g.nodes.filter((n) => !n.root).map((n) => n.name))];
  const repos = [...new Set((await Promise.all(names.map(async (n) => githubRepo((await packument(n))?.repository)))).filter((x): x is string => !!x && x !== repo))];
  await q(`insert into crawl_queue (repo, source) select unnest($1::text[]), $2 on conflict (repo) do update set hits = crawl_queue.hits + 1`, [repos, repo]);
  return { status: 'done', sha, packages: r.counts.total, note: `${lock.file}, ${r.counts.total} packages, ${r.counts.red} red, +${repos.length} repos linked` };
}

await migrate();
await q(`insert into crawl_queue (repo, source) select unnest($1::text[]), 'seed' on conflict do nothing`, [SEEDS]);
while (!stopping) {
  const job = await next();
  if (!job) { console.log('queue empty'); break; }
  const t0 = Date.now();
  try {
    const r = await crawl(job.repo, job.lockfile_sha);
    await q('update crawl_queue set status = $2, lockfile_sha = coalesce($3, lockfile_sha), packages = coalesce($4, packages), error = null, tried_at = now() where repo = $1', [job.repo, r.status, r.sha ?? null, r.packages ?? null]);
    console.log(`${new Date().toISOString()} ${job.repo}: ${r.status}${r.note ? ` (${r.note})` : ''} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    await q(`update crawl_queue set status = 'error', error = $2, tried_at = now() where repo = $1`, [job.repo, String((e as Error).message).slice(0, 500)]);
    console.log(`${new Date().toISOString()} ${job.repo}: error ${(e as Error).message}`);
  }
  if (values.once) break;
  const [c] = await q(`select count(*) filter (where status = 'pending')::int pending, count(*) filter (where status = 'done')::int done, (select count(*)::int from package_version) versions, (select count(distinct name)::int from package_version) packages from crawl_queue`);
  console.log(`  queue: ${c.done} done, ${c.pending} pending · world: ${c.packages} packages, ${c.versions} versions`);
  await new Promise((r) => setTimeout(r, Number(values.pause)));
}
await pool.end();
