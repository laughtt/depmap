import { dm, expect, live, mapUrl, ready, REPO, shot, SNAP, test, url } from "./env";

test("the connect page renders and validates the form", async ({ page }) => {
  await page.goto(url("/connect"));
  const form = page.locator(".connect-form");
  await expect(form).toBeVisible();
  await expect(page.getByText("never kept in this browser")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with GitLab" })).toBeVisible();
  await page.getByLabel("GitLab URL").fill("gitlab dot com");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(form.locator(".err").first()).toContainText("http://");
  await expect(form.locator(".err").nth(1)).toContainText("personal access token");
  await shot(page, "connect-errors");
  if (live) return;
  await page.getByLabel("GitLab URL").fill("http://localhost:8929");
  await page.getByLabel("Personal access token").fill("glpat-demo-token-1234567890");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Pick a project" })).toBeVisible();
  await page.getByPlaceholder("Filter projects").fill("shop");
  await expect(page.locator(".project-list li")).toHaveCount(1);
  await shot(page, "connect-projects");
  await page.getByRole("button", { name: "Import" }).click();
  await expect(page.locator(".dig")).toBeVisible();
  await page.waitForTimeout(1200);
  await shot(page, "dig");
  await ready(page);
  await expect(page.locator(".dig")).toBeHidden();
});

test("render mode sets ready", async ({ page }) => {
  await page.goto(url(`/render?repo=${encodeURIComponent(REPO)}&snapshot=${SNAP.upgrade}&delta=1`));
  await ready(page);
  await expect(page.locator(".render-card")).toContainText(REPO);
  const box = await page.locator(".render-screen").boundingBox();
  expect(box).toMatchObject({ width: 1200, height: 700 });
  await shot(page, "render");
});

test("the 50k-node mock loads and logs layoutMs", async ({ page }) => {
  test.skip(live, "synthetic graph is mock-only");
  const logs: string[] = [];
  page.on("console", (m) => m.text().includes("[depmap]") && logs.push(m.text()));
  await page.addInitScript(() => localStorage.setItem("depmap-layout", "tree"));
  await page.goto(url("/repos/synthetic/monorepo-50k", "big=1"));
  await ready(page, 60_000);
  const r = await dm<{ nodeCount: number; layoutMs: number; cacheHit: boolean }>(page, "({ nodeCount: dm.nodeCount, layoutMs: dm.layoutMs, cacheHit: dm.cacheHit })");
  expect(r.nodeCount).toBe(50_000);
  expect(r.cacheHit).toBe(false);
  console.log(`50k-node layoutMs: ${r.layoutMs}`);
  test.info().annotations.push({ type: "layoutMs", description: String(r.layoutMs) });
  expect(logs.some((l) => l.includes("50000 nodes"))).toBe(true);
  const t = await dm<number>(page, "(() => { const t = performance.now(); dm.map.setHover(4321, 10, 10); dm.map.setHover(-1, 0, 0); return performance.now() - t; })()");
  console.log(`50k-node hover in/out: ${t.toFixed(1)} ms`);
  await shot(page, "map-50k");
});

test("the watchers page lists sources and links matches to the map", async ({ page }) => {
  await page.goto(url(`/watchers?repo=${encodeURIComponent(REPO)}`));
  await expect(page.locator(".sources li").first()).toBeVisible();
  await expect(page.locator(".items li").first()).toBeVisible();
  await shot(page, "watchers");
  const match = page.locator(".pkg.on").first();
  test.skip(!(await match.count()), "no post names a package in this repo");
  const name = await match.textContent();
  await match.click();
  await ready(page);
  await expect(page.locator(".drawer .pv-name")).toHaveText(name!);
  await shot(page, "watchers-focus");
});

test("search finds a package and opens it", async ({ page }) => {
  await page.goto(mapUrl());
  await ready(page);
  await page.keyboard.press("/");
  await page.keyboard.type("chalk");
  await expect(page.locator(".results li").first()).toContainText("chalk");
  await page.keyboard.press("Enter");
  await expect(page.locator(".drawer .pv-name")).toHaveText("chalk");
});

test("the per-push page hangs the tree under the repo and says what to do to merge", async ({ page }) => {
  await page.goto(url(`/repos/${REPO}/scans/${SNAP.red}`));
  await ready(page);
  await expect(page.locator(".ch-title")).toContainText(REPO);
  await expect(page.locator(".gate")).toContainText("Blocked");
  await expect(page.locator(".todo-red").first()).toContainText("/depmap accept");
  const tree = await dm<{ tree: boolean; rootY: number; below: boolean }>(page,
    "({ tree: dm.map.G.tree, rootY: dm.map.G.pos[1], below: [...Array(dm.map.G.n).keys()].slice(1).every((i) => dm.map.G.primary[i] >= dm.map.G.n || dm.map.G.pos[2 * i + 1] < dm.map.G.pos[2 * dm.map.G.primary[i] + 1]) })");
  expect(tree).toEqual({ tree: true, rootY: 0, below: true });
  const directs = await dm<number>(page, "dm.map.directs.length");
  await expect(page.locator(".deps li")).toHaveCount(directs);
  await page.locator(".deps li .pv-link").first().click();
  expect(await dm<number>(page, "dm.map.sel")).toBeGreaterThan(0);
  await shot(page, "commit-page");
  await page.goto(url(`/repos/${REPO}/scans/${SNAP.upgrade}`));
  await ready(page);
  await expect(page.locator(".commit-side")).toContainText("Code change needed");
  await expect(page.locator(".changes")).toContainText("chalk");
  await shot(page, "commit-page-upgrade");
});

test("old #/ links land on the new paths, and in-app links change the path without a reload", async ({ page }) => {
  await page.goto(`/?${live ? "" : "mock=1"}#/c/${REPO}/${SNAP.red}`);
  await ready(page);
  expect(new URL(page.url()).pathname).toBe(`/repos/${REPO}/scans/${SNAP.red}`);
  await page.evaluate(() => ((window as any).__noReload = true));
  await page.getByRole("link", { name: "Open full map" }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/repos/${REPO}/map/${SNAP.red}`);
  await ready(page);
  expect(await page.evaluate(() => (window as any).__noReload)).toBe(true);
  await page.goBack();
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/repos/${REPO}/scans/${SNAP.red}`);
});

test("with login on, the landing explains depmap and signs in", async ({ page }) => {
  await page.route("**/api/health", (r) => r.fulfill({ json: { ok: true } }));
  await page.route("**/api/me", (r) => r.fulfill({ json: { loginRequired: true, gitlabUrl: "https://gitlab.com", user: null } }));
  await page.route("**/api/login", (r) => r.fulfill({ status: 401, json: { error: "Wrong username or password" } }));
  await page.goto("/");
  await expect(page.locator(".landing h1")).toContainText("coloured by risk");
  await expect(page.locator(".values > li")).toHaveCount(3);
  await expect(page.getByRole("link", { name: "Sign in with GitLab" })).toHaveAttribute("href", "/api/oauth/start");
  await page.getByRole("button", { name: "judge" }).click();
  await expect(page.getByLabel("Username")).toHaveValue("judge");
  await expect(page.getByLabel("Password")).toBeFocused();
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".form-error")).toHaveText("Wrong username or password");
  await shot(page, "landing");
});

test("the blast radius lists a risky version shared by repositories and links each scan", async ({ page }) => {
  await page.goto(url("/"));
  const blast = page.locator(".blast");
  await expect(blast.locator("li").first()).toBeVisible();
  await expect(blast.locator("header p")).toContainText("repositories");
  expect(await blast.locator("li").first().locator(".bl-repos a").count()).toBeGreaterThan(1);
  await shot(page, "blast");
  await blast.getByRole("link", { name: REPO, exact: true }).first().click();
  await expect.poll(() => new URL(page.url()).pathname).toMatch(new RegExp(`^/repos/${REPO}/scans/\\d+$`));
  await ready(page);
});
