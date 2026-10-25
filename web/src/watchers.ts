import { api, type WatchItem, type WatchSource } from "./api";
import { ago, esc, reasonIcon } from "./ui";
import { brand, nav, stateMsg, themeButton } from "./view";

const fresh = (iso: string | null) => !!iso && Date.now() - Date.parse(iso) < 864e5;
// blog posts carry no structured package list; the names the server matched in their text count too
const pkgNames = (x: { packages: { name: string }[]; matched: string[] }) => [...new Set([...x.matched, ...x.packages.map((p) => p.name)])];

export async function watchersScreen(root: HTMLElement, params: URLSearchParams) {
  root.innerHTML = `<div class="screen plain-screen">
    <header class="topbar">${brand}${nav("watchers")}<div class="spacer"></div>${themeButton()}</header>
    <main class="watch">
      <div class="watch-head">
        <div><h1>Security watchers</h1>
          <p>Attacks on npm packages are usually written up by researchers, or listed as malware advisories, hours before any CVE exists. Depmap polls these sources and checks every package they name against your repositories.</p></div>
        <div class="watch-actions"><label class="field inline"><span>Match against</span><select class="repo-pick"></select></label><button class="btn poll">${reasonIcon("security-post").svg.replace('class="ricon"', 'class="glyph"')}<span>Poll now</span></button></div>
      </div>
      <div class="watch-status" aria-live="polite"></div>
      <div class="watch-grid"><aside class="sources"></aside><section class="feed"><div class="skeleton-block"><span class="skeleton"></span><span class="skeleton w80"></span><span class="skeleton w60"></span></div></section></div>
    </main></div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  let sources: WatchSource[] = [], items: WatchItem[] = [], lastPoll: string | null = null;
  let only = new Set<string>(), touching = false, seen = new Set<string>();
  const repoPick = $<HTMLSelectElement>(".repo-pick");

  const repos = (await api.repos().catch(() => [])).map((r) => r.repo);
  const repo = () => repoPick.value;
  repoPick.innerHTML = repos.map((r) => `<option ${r === params.get("repo") ? "selected" : ""}>${esc(r)}</option>`).join("");

  function draw() {
    const matched = items.filter((x) => x.matched.length).length;
    $(".watch-status").innerHTML = `<span class="live ${fresh(lastPoll) ? "on" : ""}"></span>Last polled ${ago(lastPoll)} · ${sources.length} sources · ${sources.reduce((a, s) => a + s.items, 0).toLocaleString("en-US")} posts read${repo() ? ` · ${matched ? `<b>${matched} ${matched === 1 ? "post names" : "posts name"}</b> packages in ${esc(repo())}` : `no post names a package in ${esc(repo())}`}` : ""}`;
    $(".sources").innerHTML = `<h4>Sources</h4><ul>${sources.map((s) => `<li><button data-src="${esc(s.id)}" aria-pressed="${only.has(s.id)}"><span class="live ${fresh(s.latest) ? "on" : ""}"></span><span class="sname">${esc(s.name)}</span><span class="kind">${s.kind === "ghsa" ? "advisories" : "posts"}</span><span class="smeta">${s.items} items · newest ${ago(s.latest)}</span></button></li>`).join("")}</ul>
      ${only.size ? `<button class="link" data-clear>Show all sources</button>` : ""}`;
    const list = items.filter((x) => (!only.size || only.has(x.source)) && (!touching || x.matched.length));
    const name = (id: string) => sources.find((s) => s.id === id)?.name ?? id;
    $(".feed").innerHTML = `<div class="seg-tabs" role="tablist"><button role="tab" data-touch="0" aria-selected="${!touching}">All posts <b>${items.length}</b></button><button role="tab" data-touch="1" aria-selected="${touching}">Touching ${esc(repo() || "your repos")} <b>${matched}</b></button></div>
      ${list.length ? `<ol class="items">${list.map((x) => `<li class="${x.matched.length ? "hit" : ""} ${seen.size && !seen.has(x.id) ? "new" : ""}">
        <div class="item-meta"><span class="src-chip">${esc(name(x.source))}</span><time datetime="${esc(x.published)}" title="${esc(x.published)}">${ago(x.published)}</time>${x.matched.length ? `<span class="touch">In ${esc(repo())}</span>` : ""}</div>
        <a class="item-title" href="${esc(x.url)}" target="_blank" rel="noreferrer">${esc(x.title)}</a>
        ${x.summary ? `<p>${esc(x.summary)}</p>` : ""}
        ${pkgNames(x).length ? `<div class="pkgs">${pkgNames(x).slice(0, 12).map((n) => x.matched.includes(n)
          ? `<a class="pkg on" href="#/repo/${encodeURIComponent(repo())}?focus=${encodeURIComponent(n)}" title="Show ${esc(n)} on the map">${esc(n)}</a>`
          : `<span class="pkg">${esc(n)}</span>`).join("")}${pkgNames(x).length > 12 ? `<span class="pkg">+${pkgNames(x).length - 12}</span>` : ""}</div>` : ""}
      </li>`).join("")}</ol>` : stateMsg(touching ? `Nothing posted touches ${esc(repo())}.` : "No posts yet.", touching ? "That is the quiet you want. Matches appear here as soon as a source names one of its packages." : "Poll the sources to fetch the latest posts.")}`;
  }

  async function load(poll = false) {
    const btn = $<HTMLButtonElement>(".poll");
    btn.disabled = true;
    btn.querySelector("span")!.textContent = poll ? "Polling…" : "Poll now";
    try {
      if (poll) await api.poll();
      seen = new Set(items.map((x) => x.id));
      const [w, list] = await Promise.all([api.watchers(), api.watchItems(repo())]);
      sources = w.sources; lastPoll = w.lastPoll; items = list;
      draw();
    } catch (e) {
      $(".feed").innerHTML = stateMsg("The watchers didn't load.", esc((e as Error).message), `<button class="btn" data-retry>Try again</button>`);
    }
    btn.disabled = false;
    btn.querySelector("span")!.textContent = "Poll now";
  }

  $(".watch").addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const src = t.closest<HTMLElement>("[data-src]")?.dataset.src;
    if (src) { only.has(src) ? only.delete(src) : only.add(src); return draw(); }
    if (t.closest("[data-clear]")) { only.clear(); return draw(); }
    const touch = t.closest<HTMLElement>("[data-touch]")?.dataset.touch;
    if (touch) { touching = touch === "1"; return draw(); }
    if (t.closest(".poll")) load(true);
    if (t.closest("[data-retry]")) load();
  });
  repoPick.addEventListener("change", () => { seen.clear(); load(); });
  const tick = setInterval(() => (root.isConnected && root.querySelector(".watch") ? draw() : clearInterval(tick)), 30000);
  await load();
}
