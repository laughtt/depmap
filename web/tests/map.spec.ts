import { clickNode, dm, expect, live, mapUrl, ready, REPO, shot, SNAP, test } from "./env";

test("the map renders the expected node count", async ({ page, request }) => {
  let expected = 300;
  if (live) {
    const snaps = await (await request.get(`/api/repos/${encodeURIComponent(REPO)}/snapshots`)).json();
    const bin = await (await request.get(`/api/graphs/${snaps.at(-1).lockfileSha}.bin`)).body();
    expected = bin.readUInt32LE(8);
  }
  await page.goto(mapUrl());
  await ready(page);
  expect(await dm<number>(page, "dm.nodeCount")).toBe(expected);
  await expect(page.locator(".map-stage canvas").first()).toBeVisible();
  await expect(page.locator(".pill.total")).toContainText("packages");
  await shot(page, "map");
});

test("clicking a red node opens the drawer with reasons and a fingerprint", async ({ page }) => {
  await page.goto(mapUrl(SNAP.red));
  await ready(page);
  const reds = await dm<number[]>(page, "dm.reds()");
  expect(reds.length).toBeGreaterThan(0);
  await clickNode(page, reds[0]);
  const drawer = page.locator(".drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".drawer-state")).toContainText("Red");
  await expect(drawer.locator(".reasons li").first()).toBeVisible();
  await expect(drawer.locator(".fp")).toBeVisible();
  await expect(drawer.locator(".signals li").first()).toBeVisible();
  await shot(page, "drawer-red");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("the Upgrade tab shows a chalk call site with file:line", async ({ page }) => {
  await page.goto(mapUrl(SNAP.upgrade));
  await ready(page);
  await page.getByRole("button", { name: "Compare with previous" }).click();
  await page.locator('.adv-card[data-pkg="chalk"]').click();
  const drawer = page.locator(".drawer");
  await expect(drawer.getByRole("tab", { name: /Upgrade/ })).toHaveAttribute("aria-selected", "true");
  await expect(drawer.locator(".verdict").first()).toContainText("Code change needed");
  await expect(drawer.locator(".loc").first()).toHaveText(/src\/log\.js:1$/);
  await expect(drawer.locator(".diff .del").first()).toContainText("require('chalk')");
  await shot(page, "upgrade");
});

test("the scrubber changes the snapshot and the colours", async ({ page }) => {
  await page.goto(mapUrl(SNAP.red));
  await ready(page);
  const before = await dm<{ id: number; reds: number }>(page, "({ id: dm.snapshotId, reds: dm.map.color.filter(c => c === 2).length })");
  await page.locator(`.tick[data-snap="${SNAP.first}"]`).click();
  await page.waitForFunction((id) => (window as any).__depmap.snapshotId === id, SNAP.first);
  const after = await dm<{ id: number; reds: number }>(page, "({ id: dm.snapshotId, reds: dm.map.color.filter(c => c === 2).length })");
  expect(after.id).not.toBe(before.id);
  expect(after.reds).not.toBe(before.reds);
  await expect(page.locator(".tick.on")).toHaveAttribute("data-snap", String(SNAP.first));
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((id) => (window as any).__depmap.snapshotId !== id, SNAP.first);
  await shot(page, "scrubber");
});

test("a second page load reuses the cached layout", async ({ page }) => {
  await page.goto(mapUrl());
  await ready(page);
  expect(await dm<boolean>(page, "dm.cacheHit")).toBe(false);
  await page.reload();
  await ready(page);
  expect(await dm<boolean>(page, "dm.cacheHit")).toBe(true);
});
