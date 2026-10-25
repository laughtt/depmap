import type { DepEvent, Snapshot } from "./api";
import { date, el, esc, glyph, shortSha } from "./ui";

const short = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

const EV_ICON: Record<string, string> = { advisory: "▲", red: "●", upgrade: "↑", decision: "✓", cooldown: "◷", scan: "·", refresh: "↻", watcher: "◉" };
const EV_TONE: Record<string, string> = { advisory: "hot", red: "hot", upgrade: "acc", cooldown: "warn", decision: "acc" };
export const when = (s: Snapshot) => s.asOf ?? s.createdAt;
const evTitle = (e: DepEvent) => String(e.payload?.title ?? `${e.kind}${e.pv ? ` · ${e.pv}` : ""}`);

export class Scrubber {
  el = el<HTMLElement>(`<footer class="scrubber"></footer>`);
  current = 0;
  playing = false;
  private timer = 0;

  constructor(private snaps: Snapshot[], private events: DepEvent[], private pick: (id: number, animate: boolean) => Promise<void>, private onCompare: (on: boolean) => void, public compare = false) {
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const id = t.closest<HTMLElement>("[data-snap]")?.dataset.snap;
      if (id) { this.stop(); return void this.pick(+id, true); }
      if (t.closest(".replay")) return this.playing ? this.stop() : this.play();
      if (t.closest(".compare")) { this.compare = !this.compare; this.onCompare(this.compare); this.render(); }
    });
  }

  private x(k: number) {
    return this.snaps.length < 2 ? 50 : 4 + (92 * k) / (this.snaps.length - 1);
  }

  private eventX(at: number) {
    const t = this.snaps.map((s) => Date.parse(when(s)));
    if (at <= t[0]) return this.x(0);
    for (let k = 1; k < t.length; k++) if (at <= t[k]) return this.x(k - 1) + ((this.x(k) - this.x(k - 1)) * (at - t[k - 1])) / Math.max(1, t[k] - t[k - 1]);
    return this.x(t.length - 1);
  }

  render() {
    const cur = this.snaps.findIndex((s) => s.id === this.current);
    const s = this.snaps[cur];
    this.el.innerHTML = `
      <button class="btn replay" aria-label="${this.playing ? "Pause replay" : "Replay snapshots"}" ${this.snaps.length < 2 ? "disabled" : ""}>
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${this.playing ? `<path d="M5 3h2v10H5zM9 3h2v10H9z" fill="currentColor"/>` : `<path d="M5 3l8 5-8 5z" fill="currentColor"/>`}</svg>
        <span>${this.playing ? "Pause" : "Replay"}</span>
      </button>
      <div class="track" role="group" aria-label="Snapshots; use the left and right arrow keys to step">
        <div class="rail-line"></div>
        <div class="rail-fill" style="width:${this.x(Math.max(0, cur))}%"></div>
        ${this.markers()}
        ${this.snaps.map((n, k) => `<button class="tick ${n.id === this.current ? "on" : ""} ${n.counts.red ? "hot" : ""}" title="${shortSha(n.commitSha)} · ${esc(n.ref)} · ${n.counts.red} red" data-snap="${n.id}" style="left:${this.x(k)}%" aria-label="Snapshot ${shortSha(n.commitSha)}${n.mrIid ? `, merge request !${n.mrIid}` : ""}, ${n.counts.red} red" aria-current="${n.id === this.current}">
          <i class="knob"></i>
          <span class="tick-label">${n.mrIid ? `<span class="mr">!${n.mrIid}</span>` : n.kind === "refresh" ? `<span class="mr refresh">↻ refresh</span>` : `<code>${shortSha(n.commitSha)}</code>`}</span>
          <span class="tick-time">${short(when(n))}</span>
        </button>`).join("")}
      </div>
      <div class="scrub-meta">
        <span class="asof">${s ? `${s.gate && !s.gate.pass ? `<span class="gate-fail">${glyph(2)} Gate failing</span>` : ""}As of ${date(when(s))}` : ""}</span>
        <button class="btn compare ${this.compare ? "on" : ""}" aria-pressed="${this.compare}" ${cur <= 0 ? "disabled" : ""}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="6" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 1.5"/></svg>
          <span>Compare with previous</span>
        </button>
      </div>`;
  }

  private markers() {
    const groups = new Map<string, { x: number; kind: string; titles: string[] }>();
    for (const e of this.events.filter((e) => e.kind !== "scan")) {
      const k = this.snaps.findIndex((s) => s.id === e.snapshotId);
      const x = k >= 0 ? this.x(k) : this.eventX(Date.parse(e.at));
      const key = `${x.toFixed(2)}|${e.kind === "red" ? "advisory" : e.kind}`;
      const g = groups.get(key) ?? { x, kind: e.kind, titles: [] };
      g.titles.push(evTitle(e));
      groups.set(key, g);
    }
    const perX = new Map<string, number>();
    return [...groups.values()].map((g) => {
      const n = perX.get(g.x.toFixed(2)) ?? 0;
      perX.set(g.x.toFixed(2), n + 1);
      return `<span class="ev ${EV_TONE[g.kind] ?? ""}" style="left:calc(${g.x}% + ${n * 18}px)" title="${esc(g.titles.slice(0, 6).join("\n"))}${g.titles.length > 6 ? `\n+${g.titles.length - 6} more` : ""}">${EV_ICON[g.kind] ?? "·"}${g.titles.length > 1 ? `<sup>${g.titles.length}</sup>` : ""}</span>`;
    }).join("");
  }

  set(id: number) {
    this.current = id;
    this.render();
  }

  step(dir: number) {
    const k = this.snaps.findIndex((s) => s.id === this.current) + dir;
    if (k >= 0 && k < this.snaps.length) { this.stop(); this.pick(this.snaps[k].id, true); }
  }

  async play() {
    this.playing = true;
    let k = this.snaps.findIndex((s) => s.id === this.current);
    if (k >= this.snaps.length - 1) k = -1;
    const next = async () => {
      if (!this.playing) return;
      k++;
      if (k >= this.snaps.length) return this.stop();
      await this.pick(this.snaps[k].id, true);
      this.timer = window.setTimeout(next, 1500);
    };
    this.render();
    next();
  }

  stop() {
    this.playing = false;
    clearTimeout(this.timer);
    this.render();
  }
}
