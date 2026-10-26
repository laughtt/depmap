import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

export const live = process.env.DEPMAP_MODE === "live";
export const REPO = live ? "acme/shop" : "demo/shop";
export const SNAP = live ? { first: 1, upgrade: 2, red: 8 } : { first: 1, upgrade: 4, red: 4 };
export const url = (path: string, extra = "") => {
  const [p, q = ""] = path.split("?");
  const qs = [q, live ? "" : "mock=1", extra].filter(Boolean).join("&");
  return `${p}${qs ? `?${qs}` : ""}`;
};
export const mapUrl = (snap?: number) => url(`/repos/${REPO}${snap ? `/map/${snap}` : ""}`);

export async function ready(page: Page, timeout = 30_000) {
  await page.waitForFunction(() => (window as any).__depmap?.ready === true, null, { timeout });
}

export const dm = <T>(page: Page, fn: string) => page.evaluate(`(() => { const dm = window.__depmap; return ${fn}; })()`) as Promise<T>;

export async function shot(page: Page, name: string) {
  await page.waitForTimeout(400);
  const dir = path.join(path.dirname(test.info().config.configFile!), "../test-results/ui");
  await page.screenshot({ path: path.join(dir, `${live ? "live-" : ""}${name}.png`) });
}

export async function clickNode(page: Page, i: number) {
  const pt = await dm<{ x: number; y: number }>(page, `dm.point(${i})`);
  await page.mouse.click(pt.x, pt.y);
}

export { expect, test };
