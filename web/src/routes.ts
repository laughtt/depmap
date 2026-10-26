import { F, pvName, pvVersion, type Loaded } from "./graph";
import type { Filters } from "./map";
import { RISK, diamond, esc, glyph, num, reducedMotion } from "./ui";

const CHEVRON = `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// a box tree: the repo on top, each package once under its primary parent, only open nodes rendered
export class RouteMap {
  color: Uint8Array;
  dyn: Uint8Array;
  mask: Uint8Array;
  halo: Uint8Array;
  sel = -1;
  reveal = 255;
  onSelect: (i: number | null) => void = () => {};
  private kids: number[][];
  private also: Uint32Array;
  private order: number[];
  private vis: Uint8Array;
  private under: Uint32Array;
  private reds: Uint32Array;
  private ambers: Uint32Array;
  private open = new Set([0]);
  private limit = new Map<number, number>();

  el: HTMLElement;

  constructor(host: HTMLElement, public G: Loaded) {
    const n = G.n;
    const el = (this.el = host.appendChild(document.createElement("div")));
    el.className = "rt-host";
    this.color = new Uint8Array(n).fill(3);
    this.dyn = new Uint8Array(n);
    this.mask = new Uint8Array(n).fill(1);
    this.halo = new Uint8Array(n);
    this.vis = new Uint8Array(n);
    this.under = new Uint32Array(n);
    this.reds = new Uint32Array(n);
    this.ambers = new Uint32Array(n);
    this.kids = Array.from({ length: n }, () => []);
    for (let i = 1; i < n; i++) if (G.primary[i] < n) this.kids[G.primary[i]].push(i);
    this.also = new Uint32Array(n);
    for (const t of G.edgeTo) this.also[t]++;
    this.order = Array.from({ length: n }, (_, i) => i).sort((a, b) => G.depth[b] - G.depth[a]);
    el.addEventListener("click", (e) => {
      const d = (e.target as HTMLElement).closest<HTMLElement>("[data-tog], [data-i], [data-more]")?.dataset;
      if (!d) return;
      if (d.more) { this.limit.set(+d.more, (this.limit.get(+d.more) ?? 50) + 200); return this.render(); }
      if (d.tog) {
        const i = +d.tog;
        if (!this.open.delete(i)) this.open.add(i);
        this.render();
        return this.el.querySelector<HTMLElement>(`[data-tog="${i}"]`)?.focus();
      }
      this.open.add(+d.i!);
      this.onSelect(+d.i!);
    });
    this.count();
  }

  // red and amber totals under each node, and which rows stay visible under the filters
  private count() {
    const { G, mask, color, vis, under, reds, ambers } = this;
    vis.set(mask);
    under.fill(0); reds.fill(0); ambers.fill(0);
    for (const i of this.order) {
      if (mask[i] && color[i] === 2) reds[i]++;
      if (mask[i] && color[i] === 1) ambers[i]++;
      const p = G.primary[i];
      if (!i || p >= G.n) continue;
      under[p] += under[i] + mask[i];
      reds[p] += reds[i];
      ambers[p] += ambers[i];
      if (vis[i]) vis[p] = 1;
    }
    vis[0] = 1;
  }

  private openTo(i: number) {
    for (let p = i; p > 0 && p < this.G.n; ) { p = this.G.primary[p]; if (p < this.G.n) this.open.add(p); }
  }

  private autoOpen() {
    for (const c of [2, 1]) for (let i = 1; i < this.G.n; i++) if (this.color[i] === c && this.mask[i] && (c === 2 || this.open.size < 60)) this.openTo(i);
  }

  private row(i: number): string {
    const G = this.G, c = this.color[i];
    const kids = this.kids[i].filter((k) => this.vis[k] && G.depth[k] <= this.reveal);
    const open = this.open.has(i) && kids.length > 0;
    const hot = this.reds[i] > 0;
    const r = this.reds[i] - +(this.mask[i] && c === 2), a = this.ambers[i] - +(this.mask[i] && c === 1);
    const risks = `${r ? `<span class="rt-n risk-red" title="${r} red below">${glyph(2)}${num(r)}</span>` : ""}${a ? `<span class="rt-n risk-amber" title="${a} amber below">${glyph(1)}${num(a)}</span>` : ""}`;
    const tog = kids.length
      ? `<button class="rt-tog" data-tog="${i}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(pvName(G.names[i]))}">${CHEVRON}</button>`
      : `<span class="rt-tog"></span>`;
    const box = i === 0
      ? `<div class="rt-box rt-root"><b class="rt-name">${esc(pvName(G.names[0]))}</b><span class="rt-meta">${risks}<span>${num(this.under[0])} packages</span></span></div>`
      : `<button class="rt-box risk-${RISK[c]}${this.mask[i] ? "" : " dim"}" data-i="${i}" aria-pressed="${i === this.sel}">${glyph(c)}<span class="rt-name">${esc(pvName(G.names[i]))}</span><span class="rt-ver">${esc(pvVersion(G.names[i]))}</span>${
          G.flags[i] & F.dev ? `<span class="rt-tag">dev</span>` : ""}${G.flags[i] & F.install ? `<span class="rt-tag" title="Runs an install script">${diamond}</span>` : ""}${
          this.halo[i] ? `<span class="rt-tag rt-new">${this.halo[i] === 1 ? "+ added" : "↑ upgraded"}</span>` : ""}<span class="rt-meta">${risks}${this.under[i] ? `<span>${num(this.under[i])} below</span>` : ""}${
          this.also[i] > 1 ? `<span>also used by ${num(this.also[i] - 1)}</span>` : ""}</span></button>`;
    const head = `<div class="rt-row">${tog}${box}</div>`;
    if (!open) return `<li class="${hot ? "hot" : ""}">${head}</li>`;
    const rank = (k: number) => (this.reds[k] ? 2 : this.ambers[k] ? 1 : 0);
    kids.sort((a, b) => rank(b) - rank(a) || this.under[b] - this.under[a] || G.names[a].localeCompare(G.names[b]));
    const lim = this.limit.get(i) ?? 50;
    const shown = kids.filter((k, j) => j < lim || this.open.has(k) || k === this.sel || this.halo[k]);
    const more = kids.length - shown.length;
    return `<li class="${hot ? "hot" : ""}">${head}<ul>${shown.map((k) => this.row(k)).join("")}${more > 0 ? `<li class="rt-more"><button class="btn ghost" data-more="${i}">Show ${num(more)} more</button></li>` : ""}</ul></li>`;
  }

  render() {
    this.el.innerHTML = `<ul class="rt">${this.row(0)}</ul>`;
  }

  refresh() {
    this.render();
  }

  readPalette() {}

  setState(color: Uint8Array, dyn: Uint8Array, animate = false) {
    const flips = animate ? [...color.keys()].filter((i) => color[i] !== this.color[i]) : [];
    this.color = color;
    this.dyn = dyn;
    this.count();
    this.autoOpen();
    this.render();
    this.pulse(flips);
  }

  setFilters(f: Filters) {
    const { flags, depth, n, maxDepth } = this.G;
    for (let i = 0; i < n; i++) {
      const d = depth[i] === 255 ? 99 : depth[i];
      this.mask[i] = +(f.risk[this.color[i]] && (!f.installOnly || (flags[i] & F.install) > 0) && (f.dev || !(flags[i] & F.dev)) && d >= f.depth[0] && (d <= f.depth[1] || f.depth[1] >= maxDepth));
    }
    this.mask[0] = 1;
    this.count();
    this.render();
  }

  setHalos(added: number[], upgraded: number[]) {
    this.halo.fill(0);
    for (const i of added) { this.halo[i] = 1; this.openTo(i); }
    for (const i of upgraded) { this.halo[i] = 2; this.openTo(i); }
    this.render();
  }

  pulse(nodes: number[]) {
    if (reducedMotion()) return;
    for (const i of nodes) this.el.querySelector(`[data-i="${i}"]`)?.classList.add("flash");
  }

  select(i: number | null, fly = false) {
    this.sel = i ?? -1;
    if (i !== null) this.openTo(i);
    this.render();
    if (fly && i !== null) this.el.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  }

  // where row i sits inside el, opening its path first (the tests click through this)
  viewport(i: number) {
    if (!this.el.querySelector(`[data-i="${i}"]`)) { this.openTo(i); this.render(); }
    const b = this.el.querySelector<HTMLElement>(`[data-i="${i}"]`)!;
    b.scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect(), h = this.el.getBoundingClientRect();
    return { x: r.left - h.left + Math.min(r.width / 2, 80), y: r.top - h.top + r.height / 2 };
  }

  kill() {
    this.el.remove();
  }
}
