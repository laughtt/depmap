// Makes the README GIFs: the animated architecture, and walkthroughs recorded on the hosted app with the public demo repo.
// usage: JUDGE_PASSWORD=… node scripts/gifs/make.mjs [architecture|tour|map|fixes|all]   (needs ffmpeg)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = createRequire(new URL('../../web/package.json', import.meta.url))('@playwright/test');
const OUT = new URL('../../docs/img/', import.meta.url).pathname;
const APP = process.env.DEPTHMAP_URL ?? 'https://lac.adtomic.co';
const SCAN = '/repos/demo/acme-shop/scans/189', MAP = '/repos/demo/acme-shop/map/189';
const what = process.argv[2] ?? 'all';

// palette per GIF keeps the dark UI crisp; 10–12 fps is plenty for UI motion
function gif(input, out, { fps = 10, width = 960, pattern = false, skip = 0 } = {}) {
  const src = pattern ? ['-framerate', String(fps), '-i', input] : ['-ss', String(skip), '-i', input];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...src, '-vf',
    `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', join(OUT, out)]);
  console.log(`docs/img/${out}`);
}

const browser = await chromium.launch();

if (what === 'architecture' || what === 'all') {
  const dir = mkdtempSync(join(tmpdir(), 'arch-'));
  const page = await browser.newPage({ viewport: { width: 960, height: 560 }, deviceScaleFactor: 1 });
  await page.goto(new URL('architecture.html', import.meta.url).href);
  const fps = 12, duration = await page.evaluate(() => window.duration);
  for (let f = 0; f < duration * fps; f++) {
    await page.evaluate((t) => window.show(t), f / fps);
    await page.screenshot({ path: join(dir, `f${String(f).padStart(4, '0')}.png`) });
  }
  gif(join(dir, 'f%04d.png'), 'architecture.gif', { fps, width: 960, pattern: true });
  rmSync(dir, { recursive: true });
}

// one recorded session per GIF, signed in as the judge. Only the public demo repo is shown: the Repositories page
// lists every repo on the server (private ones included), so the walkthroughs never open it.
async function record(name, steps, { signedIn = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `rec-${name}-`));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir, size: { width: 1280, height: 800 } } });
  const login = () => ctx.request.post(`${APP}/api/login`, { data: { username: 'judge', password: process.env.JUDGE_PASSWORD } });
  if (signedIn) await login();
  const t0 = Date.now(), page = await ctx.newPage();
  await page.setContent('<body style="margin:0;background:#06080d"></body>');
  // the clip starts when the first screen is ready, so no blank or loading frames
  let start = 0;
  await steps(page, login, () => (start ||= (Date.now() - t0) / 1000));
  await ctx.close();
  gif(join(dir, readdirSync(dir)[0]), `${name}.gif`, { fps: 10, width: 960, skip: Math.max(0, start - 0.2) });
  rmSync(dir, { recursive: true });
}
const pause = (page, s) => page.waitForTimeout(s * 1000);
const ready = (page) => page.waitForFunction(() => window.__depmap?.ready === true, null, { timeout: 60_000 });

if (what === 'tour' || what === 'all') await record('tour', async (page, login, ready0) => {
  await page.goto(`${APP}/`);
  await page.waitForSelector('.landing form');
  ready0();
  await pause(page, 3);
  await login();
  await page.goto(`${APP}${MAP}`);
  await ready(page);
  await pause(page, 2);
  await page.fill('input[type=search]', 'chalk');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.drawer:not([hidden])');
  await pause(page, 2);
  await page.click('[data-tab=upgrade]');
  await pause(page, 2.5);
  await page.goto(`${APP}${SCAN}?pv=chalk%405.6.1`);
  await page.waitForSelector('.fx');
  await pause(page, 3);
  await page.locator('#slim').scrollIntoViewIfNeeded().catch(() => {});
  await pause(page, 2.5);
}, { signedIn: false });

if (what === 'map' || what === 'all') await record('map', async (page, _, ready0) => {
  await page.goto(`${APP}${MAP}`);
  await ready(page);
  ready0();
  await pause(page, 1.5);
  for (const tab of ['Tree', 'Circle', 'Routes']) {
    await page.getByRole('button', { name: tab, exact: true }).click().catch(() => {});
    await pause(page, 2);
  }
  await page.fill('input[type=search]', 'chalk');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.drawer:not([hidden])');
  await pause(page, 2.5);
});

if (what === 'fixes' || what === 'all') await record('fixes', async (page, _, ready0) => {
  await page.goto(`${APP}${SCAN}`);
  await page.waitForSelector('.fx');
  await page.waitForTimeout(800);
  ready0();
  await pause(page, 1.5);
  const card = page.locator('.todo > li').first();
  await card.locator('.fx-sec summary', { hasText: 'Used in your code' }).click();
  await pause(page, 2);
  await card.locator('.fx-sec summary', { hasText: 'Why' }).click();
  await pause(page, 2);
  await page.mouse.wheel(0, 700);
  await pause(page, 2.5);
});

await browser.close();
