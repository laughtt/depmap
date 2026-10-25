import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { relative } from 'node:path';
import { migrate } from '../db/db.ts';
import { api } from './app.ts';

const dist = relative(process.cwd(), new URL('../../../web/dist', import.meta.url).pathname) || '.';
// CI scripts are served so any project's pipeline can fetch them (DEPMAP_SCRIPTS_URL defaults to $DEPMAP_API_URL/ci)
const ci = relative(process.cwd(), new URL('../../..', import.meta.url).pathname) || '.';
api.use('/ci/*', serveStatic({ root: ci }));
api.use('/*', serveStatic({ root: dist }));
api.get('*', serveStatic({ path: `${dist}/index.html` }));

await migrate();
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: api.fetch, port }, () => console.log(`api listening on :${port}`));
