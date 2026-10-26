// depmap:report (render): a 1200×700 PNG of the MR's delta map, via headless Chrome. Skips cleanly without a browser.
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { APP, env, readResult } from './depmap-lib.mjs';

const { receipt: r } = readResult();
rmSync('depmap.png', { force: true });
const skip = (why) => {
  console.log(`depmap render: skipped (${why}); the note is posted without the map image`);
  process.exit(0);
};

const mod = await import(env.PLAYWRIGHT_CORE_PATH ? pathToFileURL(env.PLAYWRIGHT_CORE_PATH).href : 'playwright-core').catch(() => null);
if (!mod) skip('playwright-core is not installed');
const { chromium } = mod.default ?? mod;
const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch()).catch(() => null);
if (!browser) skip('Chrome is unavailable');

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
  // DEPMAP_RENDER_URL: the UI as this job's browser reaches it, when that differs from the public DEPMAP_APP_URL
  await page.goto(`${(env.DEPMAP_RENDER_URL ?? APP).replace(/\/$/, '')}/#/render?repo=${encodeURIComponent(r.repo)}&snapshot=${r.snapshotId}&delta=1`);
  await page.waitForFunction(() => window.__depmap?.ready === true, null, { timeout: 30_000 });
  const error = await page.evaluate(() => window.__depmap.error);
  if (error) throw new Error(error);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.screenshot({ path: 'depmap.png' });
  console.log('depmap render: wrote depmap.png');
} catch (e) {
  console.log(`depmap render: failed (${e.message.split('\n')[0]})`);
} finally {
  await browser.close();
}
