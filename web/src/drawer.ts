import { api, type Advice, type CodeFix, type PvDetail } from "./api";
import { bindCopy, fixPanel, fixPending } from "./fix";
import { chains, F, pvName, type Loaded } from "./graph";
import { RISK, RISK_LABEL, ago, date, diamond, el, esc, glyph, num, reasonIcon } from "./ui";
import { session } from "./view";

export type Tab = "overview" | "paths" | "upgrade" | "decision";
const TABS: [Tab, string][] = [["overview", "Overview"], ["paths", "Paths"], ["upgrade", "Upgrade"], ["decision", "Decision"]];

type Ctx = { repo: string; snapshot: () => number; G: () => Loaded; advice: (pkg: string) => Advice | undefined; pick: (i: number) => void; close: () => void };

const host = (u: string) => { try { return new URL(u).host.replace(/^www\./, ""); } catch { return "source"; } };
const verdictText: Record<string, string> = { NEEDS_CHANGE: "Code change needed", REVIEW: "Review", NO_CHANGE: "No code change", PATH_ONLY: "Path only" };
export const verdict = (v: string) => `<span class="verdict v-${v.toLowerCase()}">${esc(verdictText[v] ?? v)}</span>`;

export class Drawer {
  el = el<HTMLElement>(`<aside class="drawer" aria-label="Package details" hidden></aside>`);
  node = -1;
  tab: Tab = "overview";
  private detail: PvDetail | null = null;
  private fix: CodeFix | null = null;
  private seq = 0;

  constructor(private ctx: Ctx) {
    this.el.addEventListener("click", (e) => {
      const t = e.target as HTMLElement;
      const tab = t.closest<HTMLElement>("[data-tab]")?.dataset.tab as Tab | undefined;
      if (tab) return this.show(tab);
      const pick = t.closest<HTMLElement>("[data-node]")?.dataset.node;
      if (pick) return ctx.pick(+pick);
      if (t.closest(".drawer-close")) ctx.close();
    });
    bindCopy(this.el);
  }

  get isOpen() { return !this.el.hidden; }

  async open(i: number, tab: Tab = this.tab) {
    this.node = i;
    this.tab = tab;
    this.el.hidden = false;
    this.detail = null;
    this.fix = null;
    this.render();
    const seq = ++this.seq;
    try {
      const pv = this.ctx.G().names[i];
      const [d, fix] = await Promise.all([api.pv(pv, this.ctx.snapshot()), api.remedy(this.ctx.snapshot(), pv).catch(() => null)]);
      if (seq !== this.seq) return;
      this.detail = d;
      this.fix = fix;
    } catch (e) {
      if (seq !== this.seq) return;
      this.el.querySelector(".drawer-body")!.innerHTML = `<div class="state-msg error"><strong>Details didn't load.</strong><p>${esc((e as Error).message)}</p><button class="btn" data-retry>Try again</button></div>`;
      this.el.querySelector("[data-retry]")!.addEventListener("click", () => this.open(i, tab));
      return;
    }
    this.render();
    this.waitForAi(seq);
  }

  // the AI code change is written in the background; show it when it lands
  private async waitForAi(seq: number) {
    while (this.fix && fixPending(this.fix)) {
      await new Promise((r) => setTimeout(r, 4000));
      if (seq !== this.seq) return;
      this.fix = await api.remedy(this.ctx.snapshot(), this.fix.pv).catch(() => null);
      if (seq !== this.seq) return;
      if (this.tab === "upgrade") this.render();
    }
  }

  close() {
    this.el.hidden = true;
    this.node = -1;
    this.seq++;
  }

  show(tab: Tab) {
    this.tab = tab;
    this.render();
  }

  private render() {
    const G = this.ctx.G(), i = this.node, pv = G.names[i], d = this.detail;
    const c = d?.color ?? 3;
    const at = pv.lastIndexOf("@");
    const chips = [
      G.flags[i] & F.direct ? "direct" : `depth ${G.depth[i] === 255 ? "?" : G.depth[i]}`,
      G.flags[i] & F.dev ? "dev" : "",
      G.flags[i] & F.install ? `${diamond} install script` : "",
      `${num(G.pathCount[i])} ${G.pathCount[i] === 1 ? "path" : "paths"}`,
    ].filter(Boolean);
    this.el.className = `drawer tone-${d ? RISK[c] : "loading"}`;
    this.el.innerHTML = `
      <header class="drawer-head">
        <div class="drawer-state">${d ? `${glyph(c)}<span>${RISK_LABEL[c]}</span>` : `<span class="skeleton w60"></span>`}</div>
        <button class="icon-btn drawer-close" aria-label="Close details (Esc)"><svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button>
        <h2 class="pv"><span class="pv-name">${esc(at > 0 ? pv.slice(0, at) : pv)}</span><span class="pv-ver">${esc(at > 0 ? pv.slice(at) : "")}</span></h2>
        <div class="chips">${chips.map((x) => `<span class="chip">${x}</span>`).join("")}</div>
        <nav class="tabs" role="tablist">${TABS.map(([t, l]) => `<button role="tab" data-tab="${t}" aria-selected="${t === this.tab}">${l}${t === "upgrade" && (this.advice() || this.fix) ? `<i class="dot"></i>` : ""}</button>`).join("")}</nav>
      </header>
      <div class="drawer-body" data-testid="drawer-${this.tab}">${d ? this.body(d) : `<div class="skeleton-block"><span class="skeleton"></span><span class="skeleton w80"></span><span class="skeleton w60"></span></div>`}</div>`;
    if (d && this.tab === "decision") this.bindDecision(d);
  }

  private advice() {
    return this.detail?.upgrade ?? this.ctx.advice(pvName(this.ctx.G().names[this.node]));
  }

  private body(d: PvDetail) {
    if (this.tab === "paths") return this.paths();
    if (this.tab === "upgrade") return this.upgrade();
    if (this.tab === "decision") return this.decision(d);
    return this.overview(d);
  }

  private overview(d: PvDetail) {
    const f = d.fingerprint, x = d.facts;
    const fp = f ? `
      <section class="fp">
        <div class="fp-head"><span class="fp-title">${esc(f.title)}</span>
          <span class="fp-score" aria-label="${f.matched} of ${f.total} signals">${Array.from({ length: f.total }, (_, k) => `<i class="${k < f.matched ? "on" : ""}"></i>`).join("")}<b>${f.matched} of ${f.total} signals</b></span></div>
        <p>${esc(f.summary)}</p>
        <ul class="signals">${f.signals.map((s) => `<li class="${s.hit ? "hit" : "miss"}"><span aria-hidden="true">${s.hit ? "✓" : "–"}</span>${esc(s.label)}</li>`).join("")}</ul>
        ${f.url ? `<a class="src" href="${esc(f.url)}" target="_blank" rel="noreferrer">Incident record · ${esc(host(f.url))}</a>` : ""}
      </section>` : "";
    const reasons = d.reasons.length
      ? `<ul class="reasons">${d.reasons.map((r) => {
          const ic = reasonIcon(r.code);
          return `<li class="sev-${esc(r.severity)}">${ic.svg}<div><b>${ic.label}</b><p>${esc(r.text)}</p>${r.url ? `<a class="src" href="${esc(r.url)}" target="_blank" rel="noreferrer">${r.code === "security-post" ? "Read the post" : "Source"} · ${esc(host(r.url))}</a>` : ""}</div></li>`;
        }).join("")}</ul>`
      : `<p class="calm">${glyph(0)} No risk signals for this version.</p>`;
    const facts: [string, string][] = [
      ["Published", x.publishedAt ? `${date(x.publishedAt)} <span class="faint">${ago(x.publishedAt)}</span>` : "Unknown"],
      ["Publisher", esc(x.publisher ?? "Unknown")],
      ["Maintainers", esc(x.maintainers.join(", ") || "Unknown")],
      ["Install scripts", x.installScripts.length ? `<span class="warn">${esc(x.installScripts.join(", "))}</span>` : "None"],
      ["Provenance", x.provenance === null ? "Unknown" : x.provenance ? "Signed build" : `<span class="warn">Missing</span>`],
      ["License", esc(x.license ?? "Unknown")],
      ...(x.deprecated ? [["Deprecated", esc(x.deprecated)] as [string, string]] : []),
      ...(x.unpublished ? [["Registry", `<span class="warn">Unpublished</span>`] as [string, string]] : []),
    ];
    const adv = d.advisories.length ? `<h3>Advisories</h3><ul class="advisories">${d.advisories.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noreferrer">${esc(a.id)}</a><span class="sev sev-${esc(a.severity.toLowerCase())}">${esc(a.severity)}</span><p>${esc(a.summary)}</p></li>`).join("")}</ul>` : "";
    const dec = d.decision ? `<p class="decided">${d.decision.action === "pin" ? "Pinned" : "Accepted"} by ${esc(d.decision.by)}${d.decision.expiresAt ? ` until ${date(d.decision.expiresAt)}` : ""}: “${esc(d.decision.reason)}”</p>` : "";
    return `${fp}<h3>Why</h3>${reasons}${dec}${adv}<h3>Facts</h3><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  }

  private paths() {
    const G = this.ctx.G(), list = chains(G, this.node, 5), total = G.pathCount[this.node];
    if (!list.length) return `<p class="calm">This package is not reachable from the app root.</p>`;
    return `<p class="lede">${total > list.length ? `Showing ${list.length} of ${num(total)} paths from the app to this package. The first one is the shortest.` : `${total === 1 ? "One path leads" : `${list.length} paths lead`} from the app to this package.`}</p>
      <ol class="chains">${list.map((ch) => `<li>${ch.map((n, k) => `<button class="hop ${k === ch.length - 1 ? "last" : ""}" data-node="${n}" style="--d:${k}">${esc(pvName(G.names[n]))}</button>`).join(`<span class="sep" aria-hidden="true">›</span>`)}</li>`).join("")}</ol>`;
  }

  private upgrade() {
    const a = this.advice(), r = this.fix;
    if (!a && !r) return `<div class="state-msg"><strong>Nothing to fix.</strong><p>Risky packages get a fix here: the version to move to, where your code uses it, and the exact code change.</p></div>`;
    if (!a) return fixPanel(r!);
    const impact = this.impact(a);
    return r ? `${fixPanel(r)}<details class="fx-sec"><summary>This change: ${esc(a.from)} → ${esc(a.to)}<span class="fx-n">${a.items.length}</span></summary><div class="fx-body">${impact}</div></details>` : impact;
  }

  private impact(a: Advice) {
    return `<div class="adv-head">${verdict(a.verdict)}<span class="bump"><b>${esc(a.package)}</b> ${esc(a.from)} <span aria-hidden="true">→</span><span class="sr">to</span> ${esc(a.to)}</span></div>
      <p class="lede">${esc(a.summary)}</p>
      ${a.items.map((it) => `<article class="site">
        <header><span class="loc">${esc(it.file)}:${it.line}</span></header>
        <p>${esc(it.problem)}</p>
        <div class="diff" role="group" aria-label="Before and after"><div class="del"><span aria-hidden="true">−</span><code>${esc(it.code)}</code></div>${it.fix.split("\n").map((l) => `<div class="add"><span aria-hidden="true">+</span><code>${esc(l)}</code></div>`).join("")}</div>
        ${it.alternatives.length ? `<div class="alts"><span>Or</span><ul>${it.alternatives.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      </article>`).join("")}
      ${a.evidence.length ? `<h3>Evidence</h3><ul class="evidence">${a.evidence.map((e) => `<li><span class="kind">${esc(e.kind.replace(/_/g, " "))}</span><p>${esc(e.text)}</p>${e.url ? `<a class="src" href="${esc(e.url)}" target="_blank" rel="noreferrer">${esc(host(e.url))}</a>` : ""}</li>`).join("")}</ul>` : ""}
      ${a.paths.length ? `<h3>Reaches you via</h3><ul class="vias">${a.paths.map((p) => `<li>${p.map(esc).join(` <span class="sep">›</span> `)}</li>`).join("")}</ul>` : ""}`;
  }

  private decision(d: PvDetail) {
    const dec = d.decision, r = this.fix, canFix = !!r?.action?.version;
    const label = dec ? ({ fix: "Fix merge request opened", pin: "Pinned", accept: "Accepted" } as const)[dec.action] : "";
    const cur = dec ? `<div class="decided">${label} by ${esc(dec.by)}${dec.expiresAt ? ` until ${date(dec.expiresAt)}` : ""}${
      dec.mrUrl ? ` · <a href="${esc(dec.mrUrl)}" target="_blank" rel="noopener">Open merge request ↗</a>` : `<p>“${esc(dec.reason)}”</p>`}</div>` : "";
    const ai = r?.ai?.status === "done" ? r.ai.fix : null, required = ai?.edits.filter((e) => e.required).length ?? 0;
    const form = `<form class="decide" novalidate>
      <fieldset class="seg"><legend>Decision</legend>
        ${canFix ? `<label><input type="radio" name="action" value="fix" checked><span><b>Fix with a merge request</b>Opens an MR on GitLab with the change below.</span></label>` : ""}
        <label><input type="radio" name="action" value="accept"${canFix ? "" : " checked"}><span><b>Accept the risk</b>The merge gate passes for this version until the decision expires.</span></label>
        <label><input type="radio" name="action" value="pin"><span><b>Pin this version</b>Keep exactly ${esc(d.version)} and block automatic bumps.</span></label>
      </fieldset>
      ${canFix ? `<div class="decide-fix" data-for="fix">
        <ul class="fx-list"><li><code>package.json</code>: ${esc(r!.action!.packageJson?.after ?? r!.action!.version!)}</li>
          ${required ? `<li>${required} code change${required > 1 ? "s" : ""} written by the AI</li>` : ""}
          <li>Lockfile regenerated</li></ul>
        <button class="btn primary" type="button" data-fix-mr>Create merge request</button>
        <p class="hint" data-fix-msg></p>
      </div>` : ""}
      <div data-for="decide"${canFix ? " hidden" : ""}>
        <label class="field"><span>Reason</span><textarea name="reason" rows="3" required placeholder="Why this is acceptable, for the audit log"></textarea><small class="err" hidden>Write a reason; it goes into the audit log.</small></label>
        <div class="row2">
          <label class="field"><span>Expires</span><select name="exp"><option value="7">In 7 days</option><option value="30" selected>In 30 days</option><option value="90">In 90 days</option><option value="">Never</option></select></label>
          <label class="field"><span>Your name</span><input name="by" value="${esc(session.user?.username ?? "reviewer")}" required></label>
        </div>
        <button class="btn primary" type="submit">Save decision</button>
        <p class="hint">Saved on the server with your name; the MR gate uses it.</p>
      </div>
    </form>`;
    return cur ? `${cur}<details class="decide-again"><summary>Change this decision</summary>${form}</details>` : form;
  }

  private bindDecision(d: PvDetail) {
    const form = this.el.querySelector<HTMLFormElement>("form.decide")!;
    form.addEventListener("change", () => {
      const fix = (form.elements.namedItem("action") as RadioNodeList).value === "fix";
      form.querySelectorAll<HTMLElement>("[data-for]").forEach((x) => (x.hidden = (x.dataset.for === "fix") !== fix));
    });
    form.querySelector("[data-fix-mr]")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement, msg = form.querySelector<HTMLElement>("[data-fix-msg]")!;
      btn.disabled = true;
      btn.textContent = "Opening merge request…";
      const r = await api.fixMr(this.ctx.snapshot(), d.pv);
      if (r.ok) {
        this.detail = { ...d, decision: { repo: this.ctx.repo, pv: d.pv, action: "fix", reason: `Fix merge request !${r.iid}`, by: session.user?.username ?? "you", mrUrl: r.mrUrl } };
        if (this.fix) this.fix = { ...this.fix, mrUrl: r.mrUrl };
        return this.render();
      }
      btn.disabled = false;
      btn.textContent = "Create merge request";
      msg.innerHTML = r.authorize ? `${esc(r.error)} <a href="${esc(r.authorize)}">Allow on GitLab</a>` : `Not opened: ${esc(r.error)}`;
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(form), reason = String(fd.get("reason")).trim();
      form.querySelector<HTMLElement>(".err")!.hidden = !!reason;
      if (!reason) return form.querySelector("textarea")!.focus();
      const days = String(fd.get("exp"));
      const btn = form.querySelector<HTMLButtonElement>("button[type=submit]")!;
      btn.disabled = true;
      btn.textContent = "Recording…";
      try {
        const r = await api.decide({
          repo: this.ctx.repo, pv: d.pv, action: fd.get("action") as "accept" | "pin", reason, by: String(fd.get("by")),
          expiresAt: days ? new Date(Date.now() + +days * 864e5).toISOString() : null,
        });
        this.detail = { ...d, decision: r.decision };
        this.render();
      } catch (err) {
        btn.disabled = false;
        btn.textContent = "Save decision";
        form.querySelector(".hint")!.textContent = `Not recorded: ${(err as Error).message}`;
      }
    });
  }
}
