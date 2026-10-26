import Graph from "graphology";
import Sigma from "sigma";
import { sdfCircle, sdfDiamond } from "sigma/rendering";
import { F, RADIUS, TREE_H, TREE_W, pvName, type Loaded } from "./graph";
import { cssVar, reducedMotion } from "./ui";

export const DYN = { vuln: 1, malicious: 2, deprecated: 4, decided: 8, changed: 16, recent: 32, fingerprint: 64 };
export type Filters = { risk: [boolean, boolean, boolean, boolean]; installOnly: boolean; dev: boolean; depth: [number, number] };
type Pulse = { i: number; t0: number; c: number };

const mix = (a: string, b: string, t: number) => {
  const p = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, k) => Math.round(v + (y[k] - v) * t).toString(16).padStart(2, "0")).join("");
};

export class DepMap {
  color: Uint8Array;
  dyn: Uint8Array;
  mask: Uint8Array;
  halo = new Uint8Array(0);
  wedge: Int32Array;
  directs: number[];
  hover = -1;
  sel = -1;
  focusSet: Uint8Array | null = null;
  path: Uint32Array<ArrayBufferLike> = new Uint32Array(0);
  overlay: boolean;
  reveal = 255;
  sigma: Sigma;
  private graph = new Graph();
  private pal = { node: [] as string[], dim: [] as string[], fade: [] as string[], fx: [] as string[], ink: "", line: "", line2: "", text: "", muted: "", accent: "" };
  private sizes: Float32Array;
  private pulses: Pulse[] = [];
  private bg: HTMLCanvasElement;
  private fx: HTMLCanvasElement;
  private raf = 0;
  private ro = new ResizeObserver(() => { if (this.el.clientWidth) { this.sigma.resize(); this.sigma.scheduleRender(); } });
  onSelect: (i: number | null) => void = () => {};
  onHover: (i: number | null, x: number, y: number) => void = () => {};

  constructor(public el: HTMLElement, public G: Loaded) {
    const n = G.n;
    this.overlay = n >= 5000;
    this.color = new Uint8Array(n).fill(3);
    this.dyn = new Uint8Array(n);
    this.mask = new Uint8Array(n).fill(1);
    this.halo = new Uint8Array(n);
    const base = n > 5000 ? 1.5 : n > 1000 ? 3 : 5.4;
    this.sizes = Float32Array.from(G.pathCount, (p, i) => (i === 0 ? base * 3.4 : Math.min(base * 4, base + base * 0.42 * Math.log2(1 + p))));
    this.wedge = new Int32Array(n).fill(-1);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => G.depth[a] - G.depth[b]);
    for (const i of order) if (i) this.wedge[i] = G.flags[i] & F.direct ? i : G.primary[i] < n ? this.wedge[G.primary[i]] : -1;
    this.directs = order.filter((i) => i && G.flags[i] & F.direct);

    el.classList.add("map");
    this.bg = el.appendChild(document.createElement("canvas"));
    this.bg.className = "map-bg";
    const stage = el.appendChild(document.createElement("div"));
    stage.className = "map-stage";
    this.fx = el.appendChild(document.createElement("canvas"));
    this.fx.className = "map-fx";

    for (let i = 0; i < n; i++) this.graph.addNode(String(i), { x: G.pos[2 * i], y: G.pos[2 * i + 1], i });
    this.readPalette();
    const lim = RADIUS * 1.24;
    this.sigma = new Sigma(this.graph, stage, {
      primitives: {
        nodes: { shapes: [sdfCircle(), sdfDiamond()], label: { font: { family: "JetBrains Mono, ui-monospace, monospace", size: 11 }, margin: 6 } },
      },
      styles: {
        nodes: {
          x: { attribute: "x" }, y: { attribute: "y" },
          size: (a) => this.sizeOf(a.i),
          color: (a) => this.colorOf(a.i),
          shape: (a) => (G.flags[a.i] & F.install ? "diamond" : "circle"),
          label: (a) => (this.labelled(a.i) ? pvName(G.names[a.i]) : ""),
          labelVisibility: (a) => (this.labelled(a.i) ? "visible" : "hidden"),
          labelColor: (a) => (a.i === this.sel || a.i === this.hover ? this.pal.text : this.pal.muted),
          labelFont: "JetBrains Mono, ui-monospace, Menlo, monospace",
          labelSize: (a) => (a.i === this.sel || a.i === this.hover ? 12 : 10.5),
          depth: (a) => (this.emph(a.i) ? "topNodes" : "nodes"),
          backdropVisibility: "hidden",
          cursor: "pointer",
        },
        edges: { color: () => this.pal.accent, size: () => (n > 5000 ? 0.8 : 1.2), visibility: "visible" },
      },
      settings: { stagePadding: 24, minCameraRatio: 0.04, maxCameraRatio: 2.5, zoomDuration: 180, labelDensity: 1, hideEdgesOnMove: false },
    });
    const level = TREE_H / (G.maxDepth + 1);
    this.sigma.setCustomBBox(G.tree ? { x: [-TREE_W / 2 - 40, TREE_W / 2 + 40], y: [-(G.maxDepth + 1.4) * level, level * 0.7] } : { x: [-lim, lim], y: [-lim, lim] });
    this.sigma.on("afterRender", () => this.draw());
    this.sigma.on("enterNode", ({ node, event }) => this.setHover(+node, event.x, event.y));
    this.sigma.on("leaveNode", () => this.setHover(-1, 0, 0));
    this.sigma.on("clickNode", ({ node }) => this.onSelect(+node));
    this.sigma.on("clickStage", () => this.onSelect(null));
    this.sigma.getMouseCaptor().on("mousemovebody", (e) => this.hover >= 0 && this.onHover(this.hover, e.x, e.y));
    this.ro.observe(el);
  }

  private sizeOf(i: number) {
    const s = this.sizes[i] * (!this.overlay && (i === this.hover || i === this.sel) ? 1.6 : 1);
    return this.G.depth[i] > this.reveal ? 0 : s;
  }

  private emph(i: number) {
    if (this.overlay) return this.color[i] === 2;
    return i === this.hover || i === this.sel || (this.focusSet ? this.focusSet[i] === 1 : this.color[i] === 2);
  }

  private labelled(i: number) {
    if (this.G.depth[i] > this.reveal && i) return false;
    if (i === 0) return true;
    if (this.G.tree && this.G.flags[i] & F.direct && i !== this.hover && i !== this.sel) return false;
    if (this.overlay) return this.color[i] === 2 && this.mask[i] === 1;
    if (i === this.hover || i === this.sel) return true;
    if (this.focusSet) return this.focusSet[i] === 1;
    return this.color[i] === 2 && this.mask[i] === 1;
  }

  private colorOf(i: number) {
    if (i === 0) return this.pal.text;
    const c = this.color[i];
    if (!this.mask[i]) return this.pal.dim[c];
    if (this.focusSet && !this.focusSet[i] && !this.overlay) return this.pal.fade[c];
    return this.pal.node[c];
  }

  readPalette() {
    const ink = cssVar("--ink");
    const node = ["--map-green", "--map-amber", "--map-red", "--map-grey"].map(cssVar);
    this.pal = {
      node, ink, dim: node.map((c) => mix(c, ink, 0.86)), fade: node.map((c) => mix(c, ink, 0.62)),
      fx: ["--green", "--amber", "--red", "--grey"].map(cssVar),
      line: cssVar("--ring"), line2: cssVar("--ring-strong"), text: cssVar("--text"), muted: cssVar("--muted"), accent: cssVar("--accent"),
    };
  }

  refresh() {
    this.sigma.refresh();
  }

  setState(color: Uint8Array, dyn: Uint8Array, animate = false) {
    const t0 = performance.now();
    if (animate && !reducedMotion()) {
      let k = 0;
      for (let i = 0; i < color.length && k < 400; i++) if (color[i] !== this.color[i]) { this.pulses.push({ i, t0, c: color[i] }); k++; }
    }
    this.color = color;
    this.dyn = dyn;
    this.refresh();
    this.kick();
  }

  pulse(nodes: number[]) {
    if (reducedMotion()) return;
    const t0 = performance.now();
    for (const i of nodes.slice(0, 400)) this.pulses.push({ i, t0, c: this.color[i] });
    this.kick();
  }

  setFilters(f: Filters) {
    const { flags, depth, n } = this.G;
    for (let i = 0; i < n; i++) {
      const d = depth[i] === 255 ? 99 : depth[i];
      this.mask[i] = +(f.risk[this.color[i]] && (!f.installOnly || (flags[i] & F.install) > 0) && (f.dev || !(flags[i] & F.dev)) && d >= f.depth[0] && (d <= f.depth[1] || f.depth[1] >= this.G.maxDepth));
    }
    this.mask[0] = 1;
    this.refresh();
  }

  setHalos(added: number[], upgraded: number[]) {
    this.halo.fill(0);
    for (const i of added) this.halo[i] = 1;
    for (const i of upgraded) this.halo[i] = 2;
    this.draw();
  }

  private pathEdges(i: number) {
    if (!this.overlay) this.graph.clearEdges();
    this.focusSet = null;
    this.path = new Uint32Array(0);
    if (i < 0) return;
    const set = new Uint8Array(this.G.n);
    set[i] = set[0] = 1;
    this.path = this.G.g.pathsToRoot(i);
    for (const e of this.path) {
      const a = this.G.edgeFrom[e], b = this.G.edgeTo[e];
      set[a] = set[b] = 1;
      if (!this.overlay) this.graph.mergeEdge(String(a), String(b));
    }
    this.focusSet = set;
  }

  private focus() {
    this.pathEdges(this.hover >= 0 ? this.hover : this.sel);
    if (this.overlay) this.draw();
    else this.refresh();
  }

  private setHover(i: number, x: number, y: number) {
    if (i === this.hover) return;
    this.hover = i;
    this.focus();
    this.onHover(i >= 0 ? i : null, x, y);
  }

  select(i: number | null, fly = false) {
    this.sel = i ?? -1;
    this.focus();
    if (fly && i !== null) this.flyTo([i], 0.32);
  }

  viewport(i: number) {
    return this.sigma.graphToViewport({ x: this.G.pos[2 * i], y: this.G.pos[2 * i + 1] });
  }

  flyTo(nodes: number[], minRatio = 0.2, animate = !reducedMotion()) {
    if (!nodes.length) return;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of nodes) {
      const d = this.sigma.getNodeDisplayData(String(i));
      if (!d) continue;
      x0 = Math.min(x0, d.x); x1 = Math.max(x1, d.x); y0 = Math.min(y0, d.y); y1 = Math.max(y1, d.y);
    }
    const state = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, ratio: Math.min(1, Math.max(minRatio, Math.max(x1 - x0, y1 - y0) * 1.5)) };
    const cam = this.sigma.getCamera();
    return animate ? cam.animate(state, { duration: 550 }) : (cam.setState(state), Promise.resolve());
  }

  resetCamera() {
    return this.sigma.getCamera().animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: reducedMotion() ? 0 : 400 });
  }

  private kick() {
    if (!this.raf && this.pulses.length) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  private fit(c: HTMLCanvasElement) {
    const { width, height } = this.el.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    if (c.width !== Math.round(width * dpr) || c.height !== Math.round(height * dpr)) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  draw() {
    this.drawBg();
    this.drawFx();
  }

  private drawBg() {
    const ctx = this.fit(this.bg), G = this.G, p = this.pal, W = this.el.clientWidth, H = this.el.clientHeight;
    if (G.tree) return this.drawTree(ctx, W);
    const o = this.sigma.graphToViewport({ x: 0, y: 0 });
    const rad = (r: number) => Math.hypot(this.sigma.graphToViewport({ x: r, y: 0 }).x - o.x, this.sigma.graphToViewport({ x: r, y: 0 }).y - o.y);
    const ringR = (d: number) => rad((d * RADIUS) / G.maxDepth);
    const top = Math.min(this.reveal, G.maxDepth);
    ctx.lineWidth = 1;
    for (let d = 1; d <= top; d++) {
      ctx.strokeStyle = d === this.reveal ? p.accent : d === 1 ? p.line2 : p.line;
      ctx.beginPath();
      ctx.arc(o.x, o.y, ringR(d), 0, Math.PI * 2);
      ctx.stroke();
    }
    const outer = ringR(top);
    ctx.font = "500 10px Instrument Sans, system-ui, sans-serif";
    ctx.fillStyle = p.muted;
    ctx.textAlign = "center";
    for (let d = 1; d <= top; d++) {
      const r = ringR(d);
      if (r - ringR(d - 1) > 14) ctx.fillText(String(d), o.x, o.y - r - 4);
    }
    if (this.reveal < 255 || outer < 60) return;

    const counts = new Map<number, number>(), worst = new Map<number, number>();
    for (let i = 1; i < G.n; i++) {
      const w = this.wedge[i];
      if (w < 0) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
      const c = this.color[i], rank = [0, 2, 3, 1][c];
      if (rank > [0, 2, 3, 1][worst.get(w) ?? 0]) worst.set(w, c);
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
    const ang = (i: number) => Math.atan2(G.pos[2 * i + 1], G.pos[2 * i]);
    const r0 = ringR(1) * 0.55;
    ctx.strokeStyle = p.line;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const w of this.directs) {
      const span = (2 * Math.PI * (counts.get(w) ?? 1)) / total, a = ang(w);
      const edge = this.sigma.graphToViewport({ x: Math.cos(a - span / 2), y: Math.sin(a - span / 2) });
      const ux = edge.x - o.x, uy = edge.y - o.y, ul = Math.hypot(ux, uy) || 1;
      ctx.beginPath();
      ctx.moveTo(o.x + (ux / ul) * r0, o.y + (uy / ul) * r0);
      ctx.lineTo(o.x + (ux / ul) * (outer + 8), o.y + (uy / ul) * (outer + 8));
      ctx.stroke();
      if (span * outer < 13) continue;
      const mid = this.sigma.graphToViewport({ x: Math.cos(a), y: Math.sin(a) });
      let th = Math.atan2(mid.y - o.y, mid.x - o.x);
      const c = worst.get(w) ?? 0, flip = Math.cos(th) < 0;
      const cx = Math.cos(th), cy = Math.sin(th), ax = o.x + cx * (outer + 14), ay = o.y + cy * (outer + 14);
      const room = Math.min(cx > 0 ? (W - ax) / cx : cx < 0 ? ax / -cx : 1e9, cy > 0 ? (H - ay) / cy : cy < 0 ? ay / -cy : 1e9) - 6;
      ctx.font = `${c === 2 ? 600 : 500} 11px Instrument Sans, system-ui, sans-serif`;
      let label = pvName(G.names[w]);
      while (label.length > 4 && ctx.measureText(label).width > room) label = label.slice(0, -2) + "…";
      if (room < 24) continue;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(flip ? th + Math.PI : th);
      ctx.textAlign = flip ? "right" : "left";
      ctx.fillStyle = c === 2 ? p.fx[2] : p.muted;
      ctx.fillText(label, 0, 0);
      ctx.restore();
    }
  }

  // inverted tree: one row per depth, curved parent → child links, the chains that reach a red package drawn in red
  private drawTree(ctx: CanvasRenderingContext2D, W: number) {
    const G = this.G, p = this.pal, level = TREE_H / (G.maxDepth + 1);
    const top = Math.min(this.reveal, G.maxDepth);
    ctx.font = "500 10px Instrument Sans, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = p.line;
    ctx.fillStyle = p.muted;
    ctx.setLineDash([2, 4]);
    for (let d = 1; d <= top; d++) {
      const y = this.sigma.graphToViewport({ x: 0, y: -d * level }).y;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.fillText(d === 1 ? "direct" : `depth ${d}`, 8, y - 9);
    }
    ctx.setLineDash([]);
    if (G.n > 20000) return;
    const hot = new Uint8Array(G.n);
    for (let i = 1; i < G.n; i++) {
      if (this.color[i] !== 2 || !this.mask[i]) continue;
      for (let c = i; c > 0 && c < G.n && !hot[c]; c = G.primary[c]) hot[c] = 1;
    }
    for (const pass of [0, 1]) {
      ctx.strokeStyle = pass ? p.fx[2] : p.line2;
      ctx.globalAlpha = pass ? 0.85 : 0.5;
      ctx.lineWidth = pass ? 1.6 : 1;
      ctx.beginPath();
      for (let i = 1; i < G.n; i++) {
        const par = G.primary[i];
        if (par >= G.n || hot[i] !== pass || G.depth[i] > this.reveal) continue;
        const a = this.viewport(par), b = this.viewport(i), m = (a.y + b.y) / 2;
        ctx.moveTo(a.x, a.y);
        ctx.bezierCurveTo(a.x, m, b.x, m, b.x, b.y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    const xs = this.directs.map((i) => this.viewport(i).x).sort((a, b) => a - b);
    const crowded = xs.some((x, k) => k && x - xs[k - 1] < 11);
    ctx.textAlign = "left";
    for (const w of this.directs) {
      const c = this.color[w];
      if (crowded && c === 0) continue;
      const v = this.viewport(w), label = pvName(G.names[w]);
      ctx.save();
      ctx.translate(v.x + 3, v.y - this.sigma.scaleSize(this.sizeOf(w)) - 5);
      ctx.rotate(-Math.PI / 4);
      ctx.font = `${c === 2 ? 600 : 500} 11px Instrument Sans, system-ui, sans-serif`;
      ctx.fillStyle = c === 2 ? p.fx[2] : c === 1 ? p.fx[1] : p.muted;
      ctx.fillText(label.length > 24 ? label.slice(0, 23) + "…" : label, 0, 0);
      ctx.restore();
    }
  }

  private drawFx() {
    const ctx = this.fit(this.fx), G = this.G, p = this.pal, now = performance.now();
    const px = (i: number) => this.sigma.scaleSize(this.sizeOf(i));
    ctx.lineWidth = 1.25;
    for (let i = 1; i < G.n; i++) {
      if (G.depth[i] > this.reveal) continue;
      const red = this.color[i] === 2 && this.mask[i];
      if (!red && !this.halo[i]) continue;
      const v = this.viewport(i), r = px(i);
      if (red) {
        ctx.strokeStyle = p.fx[2];
        ctx.beginPath(); ctx.arc(v.x, v.y, r + 3.5, 0, Math.PI * 2); ctx.stroke();
      }
      if (this.halo[i]) {
        ctx.strokeStyle = p.accent;
        ctx.setLineDash(this.halo[i] === 1 ? [] : [2.5, 2.5]);
        ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(v.x, v.y, r + 7, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = p.accent;
        ctx.beginPath(); ctx.arc(v.x, v.y, r + 7, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
        if (this.halo[i] === 2) {
          ctx.fillStyle = p.accent;
          ctx.beginPath(); ctx.moveTo(v.x + r + 9, v.y - r - 9); ctx.lineTo(v.x + r + 13, v.y - r - 3); ctx.lineTo(v.x + r + 5, v.y - r - 3); ctx.fill();
        }
      }
    }
    if (this.overlay && this.path.length) {
      ctx.strokeStyle = p.accent;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (const e of this.path) {
        const a = this.viewport(G.edgeFrom[e]), b = this.viewport(G.edgeTo[e]);
        ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.font = "500 11px JetBrains Mono, ui-monospace, monospace";
      ctx.textBaseline = "middle";
      for (const i of [this.sel, this.hover]) {
        if (i <= 0) continue;
        const v = this.viewport(i), t = pvName(G.names[i]), w = ctx.measureText(t).width;
        ctx.fillStyle = p.ink;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(v.x + 10, v.y - 9, w + 10, 18);
        ctx.globalAlpha = 1;
        ctx.fillStyle = p.text;
        ctx.fillText(t, v.x + 15, v.y);
        ctx.strokeStyle = p.accent;
        ctx.beginPath(); ctx.arc(v.x, v.y, px(i) + 4, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (this.sel > 0) {
      const v = this.viewport(this.sel), r = px(this.sel) + 9;
      ctx.strokeStyle = p.text;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(v.x, v.y, r, 0, Math.PI * 2); ctx.stroke();
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        ctx.beginPath(); ctx.moveTo(v.x + Math.cos(a) * r, v.y + Math.sin(a) * r); ctx.lineTo(v.x + Math.cos(a) * (r + 6), v.y + Math.sin(a) * (r + 6)); ctx.stroke();
      }
    }
    this.pulses = this.pulses.filter((q) => now - q.t0 < 1400);
    for (const q of this.pulses) {
      const t = (now - q.t0) / 1400, v = this.viewport(q.i);
      ctx.strokeStyle = p.fx[q.c];
      ctx.globalAlpha = 1 - t;
      ctx.lineWidth = 2 * (1 - t) + 0.5;
      ctx.beginPath(); ctx.arc(v.x, v.y, px(q.i) + 4 + t * 26, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.kick();
  }

  kill() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.sigma.kill();
    this.el.replaceChildren();
  }
}
