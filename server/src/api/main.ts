import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { relative } from 'node:path';
import { migrate, q } from '../db/db.ts';
import { api, hashPassword } from './app.ts';
import { startAiWorker } from '../advisor/aifix.ts';

const dist = relative(process.cwd(), new URL('../../../web/dist', import.meta.url).pathname) || '.';
// CI scripts are served so any project's pipeline can fetch them (DEPMAP_SCRIPTS_URL defaults to $DEPMAP_API_URL/ci)
const ci = relative(process.cwd(), new URL('../../..', import.meta.url).pathname) || '.';
api.use('/ci/*', serveStatic({ root: ci }));
api.use('/*', serveStatic({ root: dist }));
api.get('*', serveStatic({ path: `${dist}/index.html` }));

await migrate();
// DEMO_LOGIN=user:password keeps a depmap account for judges; the password only lives in the env
const demo = process.env.DEMO_LOGIN?.match(/^([^:]+):(.+)$/);
if (demo) await q('insert into app_user (username, password_hash) values ($1, $2) on conflict (username) do update set password_hash = excluded.password_hash', [demo[1].toLowerCase(), hashPassword(demo[2])]);
await startAiWorker();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: api.fetch, port }, () => console.log(`api listening on :${port}`));
