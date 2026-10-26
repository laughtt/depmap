import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import Sigma from "sigma";
import { api, type AdvisoryDetail, type Remedy, type WorldPackage, type WorldVersion } from "./api";
import { RISK, RISK_LABEL, ago, cssVar, date, esc, glyph, num, reasonIcon, paths } from "./ui";
import { stateMsg, topbar } from "./view";

const LABELS: Record<string, string> = {
  runtime: "Runtime", "dev-only": "Dev only", direct: "Direct in some repo", "install-script": "Runs an install script",
  "load-bearing": "Load-bearing, one maintainer", "one-maintainer": "One maintainer", "no-provenance": "No provenance", stale: "No release in 2 years", deprecated: "Deprecated",
};
const TRUST_WARN = new Set(["install-script", "load-bearing", "one-maintainer", "no-provenance", "stale", "deprecated"]);

export async function worldScreen(root: HTMLElement, focus: string | null): Promise<{ repaint: () => void; destroy: () => void } | null> {
  root.innerHTML = `<div class="screen map-screen world-screen">
    <header class="topbar">${topbar("world", `<b class="sub-title">All dependencies</b><div class="pills world-stats" aria-live="polite"></div><div class="spacer"></div>
      <select class="world-filter" data-axis="category" aria-label="Filter by what it does"></select>
      <select class="world-filter" data-axis="label" aria-label="Filter by usage or trust"></select>
      <div class="search"><input type="search" list="world-names" placeholder="Find a package" aria-label="Find a package" autocomplete="off" spellcheck="false"><datalist id="world-names"></datalist></div>`)}</header>
    <main class="stage"><div class="map-host"></div><div class="tip" hidden></div>
      <div class="loading">${stateMsg("Loading every dependency", "Folding all scanned versions into one graph and laying it out.")}</div></main>
  </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const stage = $(".stage");

  let w: Awaited<ReturnType<typeof api.world>>;
  try {
    w = await api.world();
  } catch (e) {
    stage.innerHTML = stateMsg("The world map didn't load.", esc((e as Error).message), `<button class="btn" onclick="location.reload()">Try again</button>`);
    return null;
  }
  if (!w.nodes.length) {
    stage.innerHTML = stateMsg("Nothing scanned yet.", "Every lockfile you scan adds its packages here.", `<a class="btn primary" href="/connect">Connect a repository</a>`);
    return null;
  }

  const g = new Graph<{ x: number; y: number; size: number; n: WorldPackage }, { s: string; t: string }>();
  w.nodes.forEach((n, i) => {
    const a = (i / w.nodes.length) * Math.PI * 2 * 7, r = 50 + Math.random() * 50;
    g.addNode(n.name, { x: Math.cos(a) * r, y: Math.sin(a) * r, size: Math.min(28, 2.5 + 2.2 * Math.sqrt(n.dependents)), n });
  });
  for (const [a, b] of w.edges) if (!g.hasEdge(a, b)) g.addEdge(a, b, { s: a, t: b });
  const t0 = performance.now();
  forceAtlas2.assign(g, { iterations: g.order > 3000 ? 120 : 300, settings: { ...forceAtlas2.inferSettings(g), barnesHutOptimize: g.order > 500, adjustSizes: false } });
  (window as any).dm = { ...(window as any).dm, worldLayoutMs: Math.round(performance.now() - t0) };

  const versions = w.nodes.reduce((s, n) => s + n.versions.length, 0);
  const reds = w.nodes.filter((n) => n.color === 2).length;
  $(".world-stats").innerHTML = `<span class="pill"><b>${num(w.nodes.length)}</b> packages</span><span class="pill"><b>${num(versions)}</b> versions</span><span class="pill"><b>${num(w.edges.length)}</b> links</span><span class="pill risk-red ${reds ? "" : "zero"}">${glyph(2)}<b>${num(reds)}</b> red</span>`;
  $("#world-names").innerHTML = w.nodes.map((n) => `<option value="${esc(n.name)}">`).join("");

  const pal = () => ({ node: ["--map-green", "--map-amber", "--map-red", "--map-grey"].map(cssVar), line: cssVar("--ring"), text: cssVar("--text"), muted: cssVar("--muted"), accent: cssVar("--accent") });
  let p = pal(), sel: string | null = null, hover: string | null = null, near = new Set<string>();
  const top = new Set([...w.nodes].sort((a, b) => b.dependents - a.dependents).slice(0, 24).map((n) => n.name));
  let filter: { category: string; label: string } = { category: "", label: "" };
  const matches = (n: WorldPackage) => (!filter.category || n.category === filter.category) && (!filter.label || n.use.includes(filter.label) || n.trust.includes(filter.label));
  const lit = (k: string) => (sel ? near.has(k) : matches(g.getNodeAttribute(k, "n")));
  const filtering = () => !!(filter.category || filter.label);
  const labelled = (k: string) => k === sel || k === hover || (sel ? near.has(k) : filtering() ? matches(g.getNodeAttribute(k, "n")) && g.getNodeAttribute(k, "size") > 4 : top.has(k) || g.getNodeAttribute(k, "n").color === 2);

  $(".loading").remove();
  const sigma = new Sigma<{ x: number; y: number; size: number; n: WorldPackage }, { s: string; t: string }>(g, $(".map-host"), {
    styles: {
      nodes: {
        x: { attribute: "x" }, y: { attribute: "y" },
        size: (a) => a.size * (a.n.name === sel || a.n.name === hover ? 1.4 : 1),
        color: (a) => (lit(a.n.name) ? p.node[a.n.color] : p.line),
        label: (a) => (labelled(a.n.name) ? a.n.name : ""),
        labelVisibility: (a) => (labelled(a.n.name) ? "visible" : "hidden"),
        labelColor: (a) => (a.n.name === sel || a.n.name === hover ? p.text : p.muted),
        labelFont: "JetBrains Mono, ui-monospace, Menlo, monospace",
        labelSize: 10.5,
        depth: (a) => (a.n.name === sel || near.has(a.n.name) || a.n.color === 2 ? "topNodes" : "nodes"),
        cursor: "pointer",
      },
      // when a node is selected, only its own edges stay
      edges: { color: () => (sel ? p.accent : p.line), size: 0.6, visibility: (e) => (!sel || e.s === sel || e.t === sel ? "visible" : "hidden") },
    },
    settings: { stagePadding: 24, minCameraRatio: 0.03, maxCameraRatio: 3, labelDensity: 1, hideEdgesOnMove: g.size > 5000 },
  });

  const tip = $(".tip");
  sigma.on("enterNode", ({ node, event }) => {
    hover = node;
    const n: WorldPackage = g.getNodeAttribute(node, "n");
    tip.innerHTML = `<b>${esc(n.name)}</b><span>${num(n.versions.length)} version${n.versions.length === 1 ? "" : "s"} · ${num(n.dependents)} dependent${n.dependents === 1 ? "" : "s"}</span>`;
    tip.style.transform = `translate(${event.x + 14}px, ${event.y + 14}px)`;
    tip.hidden = false;
    sigma.refresh();
  });
  sigma.on("leaveNode", () => { hover = null; tip.hidden = true; sigma.refresh(); });
  sigma.on("clickNode", ({ node }) => select(node));
  sigma.on("clickStage", () => select(null));

  const panel = stage.appendChild(document.createElement("aside"));
  panel.className = "drawer world-drawer";
  panel.hidden = true;
  panel.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".drawer-close")) select(null);
    const dep = t.closest<HTMLElement>("[data-pkg]")?.dataset.pkg;
    if (dep && g.hasNode(dep)) select(dep);
  });

  async function select(k: string | null) {
    sel = k;
    near = new Set(k ? [k, ...g.neighbors(k)] : []);
    sigma.refresh();
    history.replaceState(null, "", k ? `/world?focus=${encodeURIComponent(k)}` : "/world");
    if (!k) { panel.hidden = true; return; }
    const n: WorldPackage = g.getNodeAttribute(k, "n");
    panel.hidden = false;
    panel.className = `drawer world-drawer tone-${RISK[n.color]}`;
    panel.innerHTML = head(n) + `<div class="drawer-body"><div class="skeleton-block"><span class="skeleton"></span><span class="skeleton w80"></span></div></div>`;
    const d = await api.worldPackage(k).catch((e) => e as Error);
    if (sel !== k) return;
    panel.querySelector(".drawer-body")!.innerHTML = d instanceof Error ? stateMsg("Details didn't load.", esc(d.message)) : body(d);
  }

  const head = (n: WorldPackage) => `<header class="drawer-head">
      <div class="drawer-state">${glyph(n.color)}<span>${RISK_LABEL[n.color]}</span></div>
      <button class="icon-btn drawer-close" aria-label="Close details"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
      <h2 class="pv"><span class="pv-name">${esc(n.name)}</span></h2>
      <div class="chips"><span class="chip cat">${esc(n.category)}</span>${[...n.use, ...n.trust].map((x) => `<span class="chip ${TRUST_WARN.has(x) ? "warn" : ""}" title="${esc(LABELS[x] ?? x)}">${esc(x)}</span>`).join("")}</div>
      <div class="chips"><span class="chip">${num(n.versions.length)} versions seen</span><span class="chip">${num(n.dependents)} dependents</span></div></header>`;

  const body = (d: Awaited<ReturnType<typeof api.worldPackage>>) => `<h3>Version history</h3>
    <ol class="versions">${d.versions.map((v) => `<li class="sev-${RISK[v.color]}">
      <div class="v-head">${glyph(v.color)}<b>${esc(v.version)}</b><span class="faint">${v.publishedAt ? `${date(v.publishedAt)} · ${ago(v.publishedAt)}` : "publish date unknown"}</span></div>
      <div class="v-facts">${[v.publisher && `by ${esc(v.publisher)}`, v.provenance ? "signed build" : v.provenance === false ? "no provenance" : null,
        v.installScripts.length && `<span class="warn">install: ${esc(v.installScripts.join(", "))}</span>`, v.deprecated && `<span class="warn">deprecated</span>`, v.license && esc(v.license)].filter(Boolean).join(" · ")}</div>
      ${v.fingerprint ? `<p class="v-fp">Looks like ${esc(v.fingerprint.title)}: ${v.fingerprint.matched} of ${v.fingerprint.total} signals</p>` : ""}
      ${v.reasons.length ? `<ul class="reasons">${v.reasons.map((r) => { const ic = reasonIcon(r.code); return `<li class="sev-${esc(r.severity)}">${ic.svg}<div><b>${ic.label}</b><p>${esc(r.text)}</p></div></li>`; }).join("")}</ul>` : ""}
      ${v.remedy ? `<p class="remedy">${remedyText(v.remedy, d.name, v.advisories.length)}</p>` : ""}
      ${v.advisories.map((a) => advisory(a, d.name)).join("")}
      ${v.repos.length ? `<div class="pkgs">${v.repos.map((r) => `<a class="pkg link" href="${paths.repo(r.split("@")[0])}?focus=${encodeURIComponent(d.name)}">${esc(r)}</a>`).join("")}</div>` : ""}
    </li>`).join("")}</ol>
    ${d.dependents.length ? `<h3>Depended on by</h3><div class="pkgs">${d.dependents.map((x) => `<button class="pkg link" data-pkg="${esc(x)}">${esc(x)}</button>`).join("")}</div>` : ""}`;

  const remedyText = (r: Remedy, name: string, n = 1) =>
    r.kind === "upgrade" ? `<b>Fix:</b> upgrade to <code>${esc(name)}@${esc(r.version)}</code> (${esc(r.bump)} bump)${n > 1 && r.clears ? `, which clears all ${n} advisories` : ""}.`
    : r.kind === "switch" ? `<b>No fixed release.</b> Move to <code>${esc(name)}@${esc(r.version)}</code>, the newest version we have seen with no advisories.`
    : `<b>No fixed release and no clean version seen.</b> Remove the dependency or replace it.`;

  // advisory text comes from outside: escape it, only turn `inline code` back into <code>
  const prose = (t: string) => esc(t).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1");
  const sectionsHtml = (x: AdvisoryDetail) => x.sections.map((sec) => `<h4>${esc(sec.title)}</h4>${sec.blocks.map((b) =>
    b.code !== undefined ? `<pre class="v-code"><code>${esc(b.code)}</code></pre>` : `<p class="v-text">${prose(b.text!)}</p>`).join("")}`).join("");

  const advisory = (a: WorldVersion["advisories"][number], name: string) => {
    const x = a.detail;
    return `<details class="v-adv">
      <summary><span class="sev sev-${esc(a.severity.toLowerCase())}">${esc(a.severity)}</span><b>${esc(a.id)}</b><span>${esc(a.summary)}</span></summary>
      <dl class="facts">
        ${x?.affected.length ? `<dt>Affected</dt><dd><code>${x.affected.map(esc).join("</code>, <code>")}</code></dd>` : ""}
        ${x?.cwe.length ? `<dt>Weakness</dt><dd>${x.cwe.map((c) => `<a href="https://cwe.mitre.org/data/definitions/${esc(c.replace("CWE-", ""))}.html" target="_blank" rel="noreferrer">${esc(c)}</a>`).join(", ")}</dd>` : ""}
        <dt>Remedy</dt><dd>${remedyText(a.remedy, name)}</dd>
        ${x?.fixLinks.length ? `<dt>Fix</dt><dd>${x.fixLinks.map((u) => `<a class="src" href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u.replace(/^https:\/\/github\.com\//, ""))}</a>`).join("<br>")}</dd>` : ""}
      </dl>
      ${x ? sectionsHtml(x) : ""}
      <a class="src" href="${esc(a.url)}" target="_blank" rel="noreferrer">Full advisory · osv.dev</a>
    </details>`;
  };

  const count = (f: (n: WorldPackage) => boolean) => w.nodes.filter(f).length;
  const cats = [...new Set(w.nodes.map((n) => n.category))].sort();
  $(`[data-axis="category"]`).innerHTML = `<option value="">Every category</option>${cats.map((c) => `<option value="${esc(c)}">${esc(c)} · ${count((n) => n.category === c)}</option>`).join("")}`;
  $(`[data-axis="label"]`).innerHTML = `<option value="">Any usage or trust</option>${Object.keys(LABELS).map((l) => `<option value="${l}">${esc(LABELS[l])} · ${count((n) => n.use.includes(l) || n.trust.includes(l))}</option>`).join("")}`;
  root.querySelectorAll<HTMLSelectElement>(".world-filter").forEach((el) => el.addEventListener("change", () => {
    filter = { ...filter, [el.dataset.axis!]: el.value };
    select(null);
  }));

  $<HTMLInputElement>(".search input").addEventListener("change", (e) => {
    const v = (e.target as HTMLInputElement).value.trim();
    if (g.hasNode(v)) select(v);
  });
  if (focus && g.hasNode(focus)) select(focus);
  return { repaint: () => { p = pal(); sigma.refresh(); }, destroy: () => sigma.kill() };
}
