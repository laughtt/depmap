import { api, isMock, type Delta, type Snapshot, type State } from "./api";
import { Drawer, verdict } from "./drawer";
import { F, loadGraph, pvName, type Loaded } from "./graph";
import { DepMap, DYN, type Filters } from "./map";
import { RouteMap } from "./routes";
import { Scrubber } from "./scrubber";
import { RISK, RISK_LABEL, diamond, esc, glyph, num, reasonIcon, reducedMotion, shortSha, paths } from "./ui";

export const dm = ((window as any).__depmap ??= { ready: false, nodeCount: 0, cacheHit: false, layoutMs: 0, snapshotId: 0 });

const graphs = new Map<string, Promise<Loaded>>();
export const graphFor = (sha: string, tree = false) => {
  const key = `${sha}${tree ? ":tree" : ""}`;
  if (!graphs.has(key)) graphs.set(key, api.graphBytes(sha).then((b) => loadGraph(b, sha, tree)));
  return graphs.get(key)!;
};

export function themeButton() {
  return `<button class="icon-btn theme" aria-label="Switch colour theme"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg></button>`;
}

export const brand = `<a class="brand" href="/" aria-label="Depmap home"><svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="10" cy="10" r="5" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="10" cy="10" r="1.7" fill="currentColor"/><circle cx="15.2" cy="6.4" r="1.3" fill="var(--red)"/></svg><span>depmap</span></a>`;

// filled from /api/me before the first route
export const session = { loginRequired: false, gitlabUrl: "http://localhost:8929", user: null as null | { username: string; name: string; avatarUrl: string | null } };

const nav = (on: string) =>
  `<nav class="topnav" aria-label="Main">${[["repos", "/", "Repositories"], ["world", "/world", "All dependencies"], ["watchers", "/watchers", "Watchers"]]
    .map(([k, href, label]) => `<a href="${href}" ${on === k ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;

function userMenu() {
  const u = session.user;
  if (!u) return "";
  const initials = (u.name || u.username).split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  return `<details class="user-menu"><summary aria-label="Account menu">${u.avatarUrl ? `<img src="${esc(u.avatarUrl)}" alt="">` : esc(initials)}</summary>
    <div class="menu"><p>Signed in as <b>@${esc(u.username)}</b>${u.name ? `<span>${esc(u.name)}</span>` : ""}</p><a href="/api/logout">Sign out</a></div></details>`;
}

// the app header: brand, main nav and account on one bar, then an optional row of page context (breadcrumb, tools)
export const topbar = (on: "repos" | "world" | "watchers" | "", sub = "", right = "") =>
  `<div class="appbar">${brand}${nav(on)}<div class="spacer"></div>${right}${themeButton()}${userMenu()}</div>${sub ? `<div class="subbar">${sub}</div>` : ""}`;

export function crumb(repo: string, tail = "") {
  const seg = repo.split("/");
  return `<nav class="crumb" aria-label="Breadcrumb"><a href="/">Repositories</a>${seg.slice(0, -1).map((s) => `<span class="sep">/</span><span>${esc(s)}</span>`).join("")}<span class="sep">/</span><a href="${paths.repo(repo)}">${esc(seg[seg.length - 1])}</a><span class="where">${tail}</span></nav>`;
}

export function stateMsg(title: string, body: string, action = "") {
  return `<div class="state-msg"><strong>${title}</strong><p>${body}</p>${action}</div>`;
}

export type MapScreen = { setSnapshot: (id: number) => Promise<void>; destroy: () => void; repo: string; keys: (e: KeyboardEvent) => boolean };

export async function mapScreen(root: HTMLElement, repo: string, snapshotId: number | null, opts: { dig?: boolean; focus?: string | null } = {}): Promise<MapScreen> {
  dm.ready = false;
  root.innerHTML = `<div class="screen map-screen">
    <header class="topbar">${topbar("repos", `${crumb(repo)}<div class="pills" aria-live="polite"></div><div class="spacer"></div>
      <div class="search"><input type="search" placeholder="Find a package" aria-label="Find a package (press /)" autocomplete="off" spellcheck="false"><kbd>/</kbd><ul class="results" role="listbox" hidden></ul></div>
      <a class="icon-btn" href="/watchers?repo=${encodeURIComponent(repo)}" aria-label="Security watchers" title="Security watchers">${reasonIcon("security-post").svg.replace('class="ricon"', "")}</a>`,
      (await isMock()) ? `<span class="demo-chip" title="Served by the in-browser mock, not the server">Demo data</span>` : "")}</header>
    <aside class="rail"></aside>
    <main class="stage"><div class="map-host"></div><div class="delta-panel" hidden></div><div class="tip" hidden></div><div class="dig" hidden></div>
      <div class="cam"><button class="icon-btn" data-zoom="in" aria-label="Zoom in">+</button><button class="icon-btn" data-zoom="out" aria-label="Zoom out">−</button><button class="icon-btn" data-zoom="reset" aria-label="Fit the whole map"><svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg></button></div>
      <div class="loading">${stateMsg("Loading the dependency map", "Fetching the graph and laying it out.")}</div></main>
  </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const stage = $(".stage");

  let snaps: Snapshot[];
  try {
    snaps = await api.snapshots(repo);
  } catch (e) {
    $(".screen").classList.add("failed");
    stage.innerHTML = stateMsg("This repository could not be opened.", esc((e as Error).message), `<a class="btn" href="/">Back to repositories</a>`);
    return { setSnapshot: async () => {}, destroy: () => {}, repo, keys: () => false };
  }
  if (!snaps.length) {
    $(".screen").classList.add("failed");
    stage.innerHTML = stateMsg("No snapshots yet.", "Run the baseline CI job, or import the project again, to scan its lockfile.", `<a class="btn" href="/connect">Connect a repository</a>`);
    return { setSnapshot: async () => {}, destroy: () => {}, repo, keys: () => false };
  }
  const events = await api.events(repo).catch(() => []);
  let snap = snaps.find((s) => s.id === snapshotId) ?? snaps[snaps.length - 1];
  // the route tree (repo box on top, dependencies as boxes below) is the default; the canvas tree and circle are one click away
  let layout = (() => { try { return localStorage.getItem("depmap-layout") ?? "routes"; } catch { return "routes"; } })();
  const tree = () => layout !== "radial";
  let G = await graphFor(snap.lockfileSha, tree());
  let state: State | null = null;
  let delta: Delta | null = null;
  let map!: DepMap | RouteMap;
  const filters: Filters = { risk: [true, true, true, true], installOnly: false, dev: true, depth: [0, G.maxDepth] };

  const drawer = new Drawer({
    repo, snapshot: () => snap.id, G: () => G,
    advice: (pkg) => delta?.advice.find((a) => a.package === pkg),
    pick: (i) => select(i, true),
    close: () => select(null),
  });
  stage.append(drawer.el);

  const scrub = new Scrubber(snaps, events, (id, animate) => go(id, animate), async (on) => { await loadDelta(on); }, false);
  root.querySelector(".screen")!.append(scrub.el);

  function select(i: number | null, fly = false) {
    stage.classList.toggle("has-drawer", i !== null && innerWidth > 760);
    map.select(i, fly);
    if (i === null) drawer.close();
    else drawer.open(i);
  }

  function mountMap() {
    map?.kill();
    $(".map-host").replaceChildren();
    map = layout === "routes" ? new RouteMap($(".map-host"), G) : new DepMap($(".map-host"), G);
    map.onSelect = (i) => select(i);
    if (map instanceof DepMap) map.onHover = (i, x, y) => tip(i, x, y);
    stage.classList.toggle("routes", layout === "routes");
    Object.assign(dm, { nodeCount: G.n, cacheHit: G.cacheHit, layoutMs: G.layoutMs, map });
  }

  const tipEl = $(".tip");
  function tip(i: number | null, x: number, y: number) {
    if (i === null || i === map.sel) return void (tipEl.hidden = true);
    const c = map.color[i];
    tipEl.hidden = false;
    tipEl.innerHTML = `<b>${esc(G.names[i])}</b><span>${glyph(c)} ${RISK_LABEL[c]} · depth ${G.depth[i]} · ${num(G.pathCount[i])} ${G.pathCount[i] === 1 ? "path" : "paths"}${G.flags[i] & F.install ? ` · ${diamond} install script` : ""}</span>`;
    const w = stage.clientWidth;
    tipEl.style.transform = `translate(${Math.min(x + 14, w - tipEl.offsetWidth - 8)}px, ${y + 16}px)`;
  }

  function where() {
    $(".where").innerHTML = `<span class="sep">/</span><b>Scan #${snap.id}</b><span class="ref">${esc(snap.ref)}</span><code>${shortSha(snap.commitSha)}</code>${snap.mrIid ? `<span class="mr">MR !${snap.mrIid}</span>` : ""}`;
    const k = state?.counts ?? snap.counts;
    $(".pills").innerHTML = `<span class="pill total"><b>${num(k.total)}</b> packages</span>${[2, 1, 3].map((c) => `<span class="pill risk-${RISK[c]} ${k[RISK[c]] ? "" : "zero"}" title="${RISK_LABEL[c]}">${glyph(c)}<b>${num(k[RISK[c]])}</b> ${RISK[c] === "grey" ? "unknown" : RISK[c]}</span>`).join("")}`;
  }

  function rail() {
    const k = state?.counts ?? snap.counts;
    const order = [2, 1, 0, 3];
    $(".rail").innerHTML = `
      <section><h4>Layout</h4><div class="seg-tabs layout-toggle" role="group" aria-label="Layout">
        ${[["routes", "Routes"], ["tree", "Tree"], ["radial", "Circle"]].map(([v, t]) => `<button data-layout="${v}" aria-pressed="${layout === v}">${t}</button>`).join("")}</div></section>
      <section><h4>Show</h4>
        ${order.map((c) => `<label class="toggle risk-${RISK[c]}"><input type="checkbox" data-risk="${c}" ${filters.risk[c] ? "checked" : ""}>${glyph(c)}<span>${["Green", "Amber", "Red", "Unknown"][c]}</span><b>${num(k[RISK[c]])}</b></label>`).join("")}
        <label class="toggle"><input type="checkbox" data-f="installOnly" ${filters.installOnly ? "checked" : ""}>${diamond}<span>Install scripts only</span><b>${num(countFlag(F.install))}</b></label>
        <label class="toggle"><input type="checkbox" data-f="dev" ${filters.dev ? "checked" : ""}><svg class="glyph" viewBox="0 0 12 12" width="12" height="12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg><span>Dev dependencies</span><b>${num(countFlag(F.dev))}</b></label>
      </section>
      <section><h4>Depth <output>${filters.depth[0] || 1}–${filters.depth[1]}</output></h4>
        <div class="range"><input type="range" min="1" max="${G.maxDepth}" value="${filters.depth[0] || 1}" data-depth="0" aria-label="Minimum depth"><input type="range" min="1" max="${G.maxDepth}" value="${filters.depth[1]}" data-depth="1" aria-label="Maximum depth"></div>
        <div class="depth-bars">${depthCounts().slice(1).map((v, d) => `<i style="--h:${Math.max(4, (v / Math.max(...depthCounts().slice(1))) * 100)}%" class="${d + 1 >= (filters.depth[0] || 1) && d + 1 <= filters.depth[1] ? "on" : ""}" title="Depth ${d + 1}: ${num(v)} packages"></i>`).join("")}</div>
      </section>
      ${layout === "routes" ? `<section class="legend"><h4>Reading the routes</h4>
        <ul>
          <li><svg viewBox="0 0 24 12" width="24" height="12"><path d="M4 0v6h18" fill="none" stroke="var(--red)" stroke-width="1.4"/></svg>Red line: how a red package reaches you</li>
          <li><span class="rt-n">${glyph(2)}2</span>Red packages further down</li>
          <li>${diamond}Runs an install script</li>
          <li><span class="rt-tag rt-new">+ added</span><span class="rt-tag rt-new">↑ upgraded</span>In this change</li>
          <li>Each package shows once, under the parent that pulls it in first</li>
        </ul>
      </section>` : `<section class="legend"><h4>Reading the map</h4>
        <ul>
          <li><svg viewBox="0 0 24 12" width="24" height="12"><circle cx="5" cy="6" r="2" fill="currentColor"/><circle cx="16" cy="6" r="4.5" fill="currentColor"/></svg>Size: how many paths reach it</li>
          <li><svg viewBox="0 0 24 12" width="24" height="12"><circle cx="12" cy="6" r="5" fill="none" stroke="currentColor"/><circle cx="12" cy="6" r="9" fill="none" stroke="currentColor" opacity=".5"/></svg>${tree() ? "Rows" : "Rings"}: depth from your app</li>${tree() ? `<li><svg viewBox="0 0 24 12" width="24" height="12"><path d="M3 2c0 5 18 3 18 9" fill="none" stroke="var(--red)" stroke-width="1.4"/></svg>Red line: how a red package reaches you</li>` : ""}
          <li><svg viewBox="0 0 24 12" width="24" height="12"><circle cx="12" cy="6" r="2.5" fill="var(--red)"/><circle cx="12" cy="6" r="5" fill="none" stroke="var(--red)"/></svg>Outlined: red, act now</li>
          <li><svg viewBox="0 0 24 12" width="24" height="12"><path d="M12 1.5 16.5 6 12 10.5 7.5 6z" fill="currentColor"/></svg>Diamond: runs an install script</li>
          <li><svg viewBox="0 0 24 12" width="24" height="12"><circle cx="12" cy="6" r="2.5" fill="currentColor"/><circle cx="12" cy="6" r="5.2" fill="none" stroke="var(--accent)"/></svg>Halo: added in this change</li>
          <li><svg viewBox="0 0 24 12" width="24" height="12"><circle cx="12" cy="6" r="2.5" fill="currentColor"/><circle cx="12" cy="6" r="5.2" fill="none" stroke="var(--accent)" stroke-dasharray="2 2"/></svg>Dashed halo: upgraded</li>
        </ul>
      </section>`}`;
  }

  const countFlag = (f: number) => { let k = 0; for (let i = 0; i < G.n; i++) if (G.flags[i] & f) k++; return k; };
  let dc: number[] | null = null;
  const depthCounts = () => {
    if (dc) return dc;
    dc = new Array(G.maxDepth + 1).fill(0);
    for (const d of G.depth) if (d !== 255) dc[d]++;
    return dc;
  };

  root.querySelector(".rail")!.addEventListener("click", async (e) => {
    const want = (e.target as HTMLElement).closest<HTMLElement>("[data-layout]")?.dataset.layout;
    if (!want || want === layout) return;
    layout = want;
    try { localStorage.setItem("depmap-layout", want); } catch {}
    const selName = drawer.isOpen ? G.names[drawer.node] : null;
    G = await graphFor(snap.lockfileSha, tree());
    mountMap();
    if (state) map.setState(state.color, state.flags);
    map.setFilters(filters);
    rail();
    if (scrub.compare) await loadDelta(snaps.findIndex((s) => s.id === snap.id) > 0);
    if (selName) select(G.byName.get(selName) ?? null);
  });

  root.querySelector(".rail")!.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.risk) filters.risk[+t.dataset.risk] = t.checked;
    if (t.dataset.f === "installOnly") filters.installOnly = t.checked;
    if (t.dataset.f === "dev") filters.dev = t.checked;
    if (t.dataset.depth) {
      filters.depth[+t.dataset.depth] = +t.value;
      if (filters.depth[0] > filters.depth[1]) filters.depth[t.dataset.depth === "0" ? 1 : 0] = +t.value;
      rail();
      root.querySelector<HTMLInputElement>(`[data-depth="${t.dataset.depth}"]`)!.focus();
    }
    map.setFilters(filters);
  });

  async function loadDelta(on: boolean) {
    const panel = $(".delta-panel");
    delta = null;
    if (!on) { panel.hidden = true; map.setHalos([], []); return; }
    try {
      delta = await api.delta(snap.id);
    } catch (e) {
      panel.hidden = false;
      panel.innerHTML = stateMsg("The comparison didn't load.", esc((e as Error).message));
      return;
    }
    const idx = (pv: string) => G.byName.get(pv) ?? -1;
    const byPkg = (name: string, ver: string) => idx(`${name}@${ver}`) >= 0 ? idx(`${name}@${ver}`) : G.names.findIndex((s) => pvName(s) === name);
    const added = delta.added.map(idx).filter((i) => i >= 0);
    const upgraded = delta.upgraded.map((u) => byPkg(u.name, u.to)).filter((i) => i >= 0);
    map.setHalos(added, upgraded);
    map.pulse(delta.colorChanged.map((c) => idx(c.pv)).filter((i) => i >= 0));
    const base = snaps.find((s) => s.id === delta!.baseSnapshotId);
    const d = delta;
    const empty = !d.added.length && !d.removed.length && !d.upgraded.length && !d.colorChanged.length;
    panel.hidden = false;
    panel.innerHTML = `<header><h3>Changes since ${base ? `<code>${shortSha(base.commitSha)}</code>` : "the previous snapshot"}</h3>
        <div class="delta-counts"><span><b>+${d.added.length}</b> added</span><span><b>↑${d.upgraded.length}</b> upgraded</span><span><b>−${d.removed.length}</b> removed</span><span><b>${d.colorChanged.length}</b> changed colour</span></div></header>
      ${empty ? `<p class="calm">Same lockfile and same risk as before. Nothing to review.</p>` : ""}
      ${d.advice.length ? `<section><h4>Upgrade impact</h4>${d.advice.map((a) => `<button class="adv-card" data-pkg="${esc(a.package)}" data-ver="${esc(a.to)}"><span class="bump"><b>${esc(a.package)}</b> ${esc(a.from)} → ${esc(a.to)}</span>${verdict(a.verdict)}<span class="sum">${esc(a.summary)}</span></button>`).join("")}</section>` : ""}
      ${d.colorChanged.length ? `<section><h4>Colour changes</h4><ul class="flips">${d.colorChanged.slice(0, 30).map((f) => `<li><button data-pv="${esc(f.pv)}">${glyph(f.from)}<span class="arrow">→</span>${glyph(f.to)}<span class="pvn">${esc(f.pv)}</span></button></li>`).join("")}</ul></section>` : ""}
      ${d.added.length ? `<section><h4>Added</h4><ul class="plain">${d.added.map((pv) => `<li><button data-pv="${esc(pv)}">${esc(pv)}</button></li>`).join("")}</ul></section>` : ""}
      ${d.removed.length ? `<section><h4>Removed</h4><ul class="ghosts">${d.removed.map((pv) => `<li><s>${esc(pv)}</s></li>`).join("")}</ul></section>` : ""}`;
  }

  $(".delta-panel").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>(".adv-card");
    const pv = t.closest<HTMLElement>("[data-pv]")?.dataset.pv;
    const i = card ? G.byName.get(`${card.dataset.pkg}@${card.dataset.ver}`) ?? G.names.findIndex((s) => pvName(s) === card.dataset.pkg) : pv ? G.byName.get(pv) ?? -1 : -1;
    if (i === undefined || i < 0) return;
    map.select(i, true);
    drawer.open(i, card ? "upgrade" : "overview");
  });

  async function go(id: number, animate = false) {
    const next = snaps.find((s) => s.id === id);
    if (!next) return;
    const prevSha = snap.lockfileSha;
    snap = next;
    scrub.set(id);
    const remount = next.lockfileSha !== prevSha;
    const selName = drawer.isOpen ? G.names[drawer.node] : null;
    if (remount) {
      const wasMax = filters.depth[1] >= G.maxDepth;
      G = await graphFor(next.lockfileSha, tree());
      if (wasMax) filters.depth[1] = G.maxDepth;
      dc = null;
      mountMap();
    }
    state = await api.state(id);
    if (snap.id !== id) return;
    map.setState(state.color, state.flags, animate && !remount);
    map.setFilters(filters);
    dm.snapshotId = id;
    where();
    rail();
    history.replaceState(null, "", `${paths.repo(repo, id)}${location.search}`);
    if (scrub.compare) await loadDelta(snaps.findIndex((s) => s.id === id) > 0);
    if (selName) {
      const i = G.byName.get(selName) ?? G.names.findIndex((x) => pvName(x) === pvName(selName));
      i > 0 ? select(i) : select(null);
    }
  }

  async function dig() {
    const host = $(".dig");
    const counts = depthCounts();
    let done = false, total = counts[0];
    const finish = () => {
      if (done) return;
      done = true;
      map.reveal = 255;
      map.refresh();
      host.classList.add("out");
      setTimeout(() => (host.hidden = true), 400);
    };
    host.hidden = false;
    host.innerHTML = `<div class="dig-head"><span class="dig-title">Mapping <b>${esc(repo)}</b></span><button class="btn ghost" data-skip>Skip</button></div><ol class="dig-steps"></ol><div class="dig-total"><b>${num(total)}</b> packages</div>`;
    host.querySelector("[data-skip]")!.addEventListener("click", finish);
    const steps = host.querySelector(".dig-steps")!;
    const per = 2500 / G.maxDepth;
    for (let d = 1; d <= G.maxDepth && !done; d++) {
      map.reveal = d;
      map.refresh();
      total += counts[d];
      steps.insertAdjacentHTML("beforeend", `<li><span>depth ${d}</span><b>${num(counts[d])}</b></li>`);
      host.querySelector(".dig-total b")!.textContent = num(total);
      await new Promise((r) => setTimeout(r, per));
    }
    finish();
  }

  const input = $<HTMLInputElement>(".search input"), results = $(".results");
  let hits: number[] = [], active = 0;
  const showHits = () => {
    results.hidden = !hits.length && !input.value;
    results.innerHTML = hits.length
      ? hits.map((i, k) => `<li role="option" data-i="${i}" aria-selected="${k === active}">${glyph(map.color[i])}<span>${esc(G.names[i])}</span><small>d${G.depth[i]}</small></li>`).join("")
      : input.value ? `<li class="none">No package matches “${esc(input.value)}”</li>` : "";
  };
  const choose = (i: number) => { input.blur(); results.hidden = true; select(i, true); };
  input.addEventListener("input", () => {
    hits = input.value.trim() ? Array.from(G.g.search(input.value.trim(), 8)) : [];
    active = 0;
    showHits();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % Math.max(1, hits.length); showHits(); }
    if (e.key === "Enter" && hits[active] !== undefined) choose(hits[active]);
    if (e.key === "Escape") { input.value = ""; hits = []; showHits(); input.blur(); }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 150));
  results.addEventListener("mousedown", (e) => {
    const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
    if (i) choose(+i);
  });

  stage.querySelector(".cam")!.addEventListener("click", (e) => {
    const z = (e.target as HTMLElement).closest<HTMLElement>("[data-zoom]")?.dataset.zoom;
    if (!(map instanceof DepMap)) return;
    const cam = map.sigma.getCamera();
    if (z === "in") cam.zoomIn({ factor: 1.6 });
    if (z === "out") cam.zoomOut({ factor: 1.6 });
    if (z === "reset") map.resetCamera();
  });

  mountMap();
  stage.querySelector(".loading")!.remove();
  where();
  rail();
  scrub.set(snap.id);
  const wantDig = opts.dig && !reducedMotion();
  if (wantDig) { map.reveal = 0; map.refresh(); }
  await go(snap.id);
  if (wantDig) await dig();
  const focus = opts.focus && G.names.findIndex((s) => pvName(s) === opts.focus || s === opts.focus);
  if (typeof focus === "number" && focus > 0) select(focus, true);
  dm.ready = true;

  return {
    repo,
    setSnapshot: (id) => go(id),
    destroy: () => { scrub.stop(); map.kill(); },
    keys: (e) => {
      if (e.key === "/" ) { e.preventDefault(); input.focus(); return true; }
      if (e.key === "Escape") { if (drawer.isOpen) select(null); else if (!$(".dig").hidden) $<HTMLButtonElement>("[data-skip]").click(); return true; }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { scrub.step(e.key === "ArrowRight" ? 1 : -1); return true; }
      return false;
    },
  };
}

export async function renderScreen(root: HTMLElement, params: URLSearchParams) {
  dm.ready = false;
  root.innerHTML = `<div class="render-screen"><div class="map-host"></div><div class="render-card"></div><div class="render-legend"></div></div>`;
  const repo = params.get("repo") ?? "", snapshotId = params.get("snapshot");
  try {
    const snaps = await api.snapshots(repo);
    const snap = snaps.find((s) => String(s.id) === snapshotId) ?? snaps[snaps.length - 1];
    const G = await graphFor(snap.lockfileSha);
    const [state, delta] = await Promise.all([api.state(snap.id), params.get("delta") === "1" ? api.delta(snap.id) : Promise.resolve(null)]);
    const map = new DepMap(root.querySelector(".map-host")!, G);
    map.setState(state.color, state.flags);
    const idx = (pv: string) => G.byName.get(pv) ?? -1;
    const added = delta?.added.map(idx).filter((i) => i >= 0) ?? [];
    const upgraded = delta?.upgraded.map((u) => G.byName.get(`${u.name}@${u.to}`) ?? G.names.findIndex((s) => pvName(s) === u.name)).filter((i) => i >= 0) ?? [];
    const flipped = delta?.colorChanged.map((c) => idx(c.pv)).filter((i) => i >= 0) ?? [];
    map.setHalos(added, upgraded);
    const focus = params.get("focus");
    let region = focus && idx(focus) >= 0 ? [idx(focus)] : [...added, ...upgraded, ...flipped];
    if (!region.length) for (let i = 0; i < G.n; i++) if (state.flags[i] & DYN.changed) region.push(i);
    const k = state.counts;
    root.querySelector(".render-card")!.innerHTML = `${brand}<div class="rc-repo"><b>${esc(repo)}</b> <code>${shortSha(snap.commitSha)}</code>${snap.mrIid ? ` <span class="mr">MR !${snap.mrIid}</span>` : ""}</div>
      <div class="pills"><span class="pill total"><b>${num(k.total)}</b> packages</span>${[2, 1, 3].map((c) => `<span class="pill risk-${RISK[c]} ${k[RISK[c]] ? "" : "zero"}">${glyph(c)}<b>${num(k[RISK[c]])}</b> ${RISK[c] === "grey" ? "unknown" : RISK[c]}</span>`).join("")}</div>
      ${delta ? `<div class="rc-delta">+${delta.added.length} added · ↑${delta.upgraded.length} upgraded · −${delta.removed.length} removed · ${delta.colorChanged.length} changed colour</div>` : ""}`;
    root.querySelector(".render-legend")!.innerHTML = `${[2, 1, 0].map((c) => `<span>${glyph(c)}${["Green", "Amber", "Red"][c]}</span>`).join("")}<span>${diamond}Install script</span><span><i class="halo"></i>Added</span><span><i class="halo dashed"></i>Upgraded</span>`;
    if (region.length) {
      const set = new Uint8Array(G.n);
      for (const i of region) { set[i] = 1; for (let c = G.primary[i]; c < G.n && !set[c]; c = G.primary[c]) set[c] = 1; }
      set[0] = 1;
      map.focusSet = set;
      map.refresh();
      await map.flyTo(region, 0.3, false);
    }
    await new Promise<void>((r) => map.sigma.once("afterRender", () => r()) && map.sigma.scheduleRender());
    Object.assign(dm, { nodeCount: G.n, cacheHit: G.cacheHit, layoutMs: G.layoutMs, snapshotId: snap.id, ready: true });
  } catch (e) {
    root.innerHTML = `<div class="render-screen">${stateMsg("Render failed", esc((e as Error).message))}</div>`;
    Object.assign(dm, { ready: true, error: (e as Error).message });
  }
}
