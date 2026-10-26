import { api, type Advice, type CodeFix, type PvDetail } from "./api";
import { bindCopy, fixPanel, fixPending } from "./fix";
import { verdict } from "./drawer";
import { F, pvName, pvVersion } from "./graph";
import { DepMap } from "./map";
import { RISK, ago, esc, glyph, num, shortSha, paths } from "./ui";
import { crumb, dm, graphFor, stateMsg, topbar } from "./view";

// One public page per push: the inverted dependency tree, what to do before merging, the changes, and the current dependencies.
export async function commitScreen(root: HTMLElement, repo: string, snapshotId: number | null, focus: string | null = null) {
  dm.ready = false;
  root.innerHTML = `<div class="commit-screen"><header class="commit-head topbar">${topbar("repos", `${crumb(repo, snapshotId ? `<span class="sep">/</span><b>Scan #${snapshotId}</b>` : "")}<div class="ch-title"></div>`)}</header>
    <div class="commit-tree map-host"></div><aside class="commit-side"></aside></div>`;
  const $ = (s: string) => root.querySelector<HTMLElement>(s)!;
  try {
    const snaps = await api.snapshots(repo);
    const snap = snaps.find((s) => s.id === snapshotId) ?? snaps[snaps.length - 1];
    if (!snap) throw new Error(`No scans of ${repo} yet`);
    const [G, state, delta] = await Promise.all([graphFor(snap.lockfileSha, true), api.state(snap.id), api.delta(snap.id)]);
    const map = new DepMap($(".commit-tree"), G);
    map.setState(state.color, state.flags);
    const idx = (pv: string) => G.byName.get(pv) ?? -1;
    map.setHalos(delta.added.map(idx).filter((i) => i >= 0), delta.upgraded.map((u) => idx(`${u.name}@${u.to}`)).filter((i) => i >= 0));

    const reds = [...state.color.keys()].filter((i) => i > 0 && state.color[i] === 2).slice(0, 25);
    const [details, fixes] = await Promise.all([Promise.all(reds.map((i) => api.pv(G.names[i], snap.id))), api.remedies(snap.id).catch(() => [] as CodeFix[])]);
    const fixOf = new Map(fixes.map((r) => [r.pv, r]));
    const worth = fixes.filter((r) => r.color === 1 && r.action);
    // the gate as it was at this push, not with decisions made later
    const blocking = details.filter((d) => (snap.gate ? snap.gate.undecidedReds.includes(d.pv) : !d.decision));
    const changes = delta.advice.filter((a) => a.verdict === "NEEDS_CHANGE" || a.verdict === "REVIEW");
    const k = state.counts, pass = snap.gate ? snap.gate.pass : blocking.length === 0;

    $(".ch-title").innerHTML = `<b>${esc(repo)}</b> <code>${shortSha(snap.commitSha)}</code> <span class="muted">${esc(snap.ref ?? "")}${snap.mrIid ? ` · MR !${snap.mrIid}` : ""} · ${ago(snap.createdAt)}</span>
      <span class="gate ${pass ? "ok" : "no"}">${pass ? "Ready to merge" : `Blocked: ${blocking.length} red package${blocking.length === 1 ? "" : "s"}`}</span>
      <a class="btn-link" href="${paths.repo(repo, snap.id)}">Open full map</a>`;

    const rank = (i: number) => [1, 2, 3, 0][state.color[i]];
    const directs = map.directs.slice().sort((a, b) => rank(b) - rank(a) || G.names[a].localeCompare(G.names[b]));
    const under = new Map<number, number>();
    for (let i = 1; i < G.n; i++) if (map.wedge[i] >= 0 && map.wedge[i] !== i) under.set(map.wedge[i], (under.get(map.wedge[i]) ?? 0) + 1);
    const pvLink = (i: number, text = G.names[i]) => `<button class="pv-link" data-i="${i}">${glyph(state.color[i])}<code>${esc(text)}</code></button>`;

    $(".commit-side").innerHTML = `
      <section class="cs-card"><h3>To merge</h3>${
        !blocking.length && !changes.length
          ? `<p class="muted">Nothing to do: no undecided red packages and no code changes needed.</p>`
          : `<ol class="todo">${blocking.map((d) => todoRed(d, delta.upgraded, idx(d.pv), (G.flags[idx(d.pv)] & F.direct) > 0, fixOf.get(d.pv))).join("")}${changes.map((a) => todoCode(a, idx)).join("")}</ol>`
      }</section>
      ${worth.length ? `<section class="cs-card"><h3>Worth fixing <span class="muted">${worth.length} amber</span></h3><ol class="todo">${
        worth.map((r) => `<li>${pvLink(idx(r.pv))}${fixPanel(r)}</li>`).join("")}</ol></section>` : ""}
      <section class="cs-card"><h3>Changes in this push</h3>${changesHtml(delta, idx, pvLink)}</section>
      <section class="cs-card"><h3>Dependencies <span class="muted">${map.directs.length} direct · ${num(k.total)} total</span></h3>
        <div class="pills">${[2, 1, 0].map((c) => `<span class="pill risk-${RISK[c]} ${k[RISK[c]] ? "" : "zero"}">${glyph(c)}<b>${num(k[RISK[c]])}</b> ${RISK[c]}</span>`).join("")}</div>
        <input class="cs-filter" type="search" placeholder="Filter dependencies" aria-label="Filter dependencies">
        <ul class="deps">${directs.map((i) => `<li data-name="${esc(pvName(G.names[i]))}">${pvLink(i, pvName(G.names[i]))}<span class="ver">${esc(pvVersion(G.names[i]))}</span>${G.flags[i] & F.dev ? `<span class="tag">dev</span>` : ""}<span class="muted">+${num(under.get(i) ?? 0)}</span></li>`).join("")}</ul>
      </section>`;

    root.querySelector(".cs-filter")!.addEventListener("input", (e) => {
      const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
      root.querySelectorAll<HTMLElement>(".deps li").forEach((li) => (li.hidden = !!q && !li.dataset.name!.toLowerCase().includes(q)));
    });
    // AI fixes are written in the background; refresh just those blocks until none is pending
    const poll = async () => {
      if (!root.querySelector(".fx")) return;
      const now = await api.remedies(snap.id).catch(() => fixes);
      for (const r of now) {
        const el = root.querySelector<HTMLElement>(`.fx[data-fix="${CSS.escape(r.pv)}"]`);
        if (el && fixes.find((x) => x.pv === r.pv && fixPending(x)) && !fixPending(r)) el.outerHTML = fixPanel(r);
      }
      fixes.splice(0, fixes.length, ...now);
      if (fixes.some(fixPending)) setTimeout(poll, 4000);
    };
    if (fixes.some(fixPending)) setTimeout(poll, 4000);
    bindCopy(root);
    root.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (b) map.select(+b.dataset.i!, true);
    });
    map.onSelect = (i) => map.select(i);
    const region = [...reds, ...delta.added.map(idx), ...delta.upgraded.map((u) => idx(`${u.name}@${u.to}`))].filter((i) => i > 0);
    if (region.length && G.n > 400) await map.flyTo(region, 0.5, false);
    // a row in the MR comment links here with ?pv=: bring that package's fix into view, opened
    const card = focus && root.querySelector<HTMLElement>(`.fx[data-fix="${CSS.escape(focus)}"]`);
    if (card) {
      card.closest("li")?.classList.add("focused");
      card.querySelector("details")?.setAttribute("open", "");
      card.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    Object.assign(dm, { map, nodeCount: G.n, cacheHit: G.cacheHit, layoutMs: G.layoutMs, snapshotId: snap.id, ready: true });
  } catch (e) {
    root.innerHTML = `<div class="commit-screen">${stateMsg("This page could not be built", esc((e as Error).message))}</div>`;
    Object.assign(dm, { ready: true, error: (e as Error).message });
  }
}

const copy = (cmd: string) => `<code class="cmd">${esc(cmd)}</code>`;

function todoRed(d: PvDetail, upgraded: { name: string; from: string; to: string }[], i: number, direct: boolean, r?: CodeFix) {
  const fix = d.reasons.map((r) => r.text.match(/Fixed in ([\w.+-]+?)(?:,|\.?$|\. )/)?.[1]).find(Boolean);
  const back = upgraded.find((u) => u.name === d.name && u.to === d.version)?.from;
  const why = d.reasons.find((r) => r.severity === "red") ?? d.reasons[0];
  const action = fix
    ? `Upgrade <code>${esc(d.name)}</code> to <b>${esc(fix)}</b>${direct ? " in package.json." : " (it is transitive: add an <code>overrides</code> entry in package.json)."}`
    : back
      ? `Stay on <code>${esc(d.name)}@${esc(back)}</code>: revert this bump, or pin it.`
      : `Remove or replace <code>${esc(d.name)}</code>; no fixed version is published.`;
  return `<li class="todo-red"><button class="pv-link" data-i="${i}">${glyph(2)}<code>${esc(d.pv)}</code></button>
    ${r ? "" : why ? `<p>${esc(why.text)}${why.url ? ` <a href="${esc(why.url)}" target="_blank" rel="noopener">source</a>` : ""}</p>` : ""}
    ${d.fingerprint ? `<p class="fp">Looks like <b>${esc(d.fingerprint.title)}</b>: ${d.fingerprint.matched} of ${d.fingerprint.total} signals</p>` : ""}
    ${r ? fixPanel(r) : `<p><b>Fix:</b> ${action}</p>`}
    <details class="fx-sec"><summary>Accept the risk instead</summary><div class="fx-body"><p>Comment on the MR:</p>${copy(`/depmap accept ${d.pv} 7d: <reason>`)}</div></details></li>`;
}

function todoCode(a: Advice, idx: (pv: string) => number) {
  return `<li class="todo-code"><button class="pv-link" data-i="${idx(`${a.package}@${a.to}`)}">${verdict(a.verdict)}<code>${esc(a.package)} ${esc(a.from)} → ${esc(a.to)}</code></button>
    <p>${esc(a.summary)}</p>${a.items.map((it) => `<p><code>${esc(it.file)}:${it.line}</code> ${esc(it.problem)} <b>Fix:</b> ${esc(it.fix)}</p>`).join("")}</li>`;
}

function changesHtml(delta: Awaited<ReturnType<typeof api.delta>>, idx: (pv: string) => number, pvLink: (i: number, text?: string) => string) {
  if (delta.baseSnapshotId === null) return `<p class="muted">First scan of this branch: everything is new.</p>`;
  const verdictOf = (name: string) => delta.advice.find((a) => a.package === name)?.verdict;
  const rows = [
    ...delta.upgraded.map((u) => { const v = verdictOf(u.name); return `<li><span class="chg up">↑</span>${pvLink(idx(`${u.name}@${u.to}`), `${u.name} ${u.from} → ${u.to}`)}${v ? verdict(v) : ""}</li>`; }),
    ...delta.added.map((pv) => `<li><span class="chg add">+</span>${pvLink(idx(pv))}</li>`),
    ...delta.removed.map((pv) => `<li><span class="chg rm">−</span><code>${esc(pv)}</code></li>`),
    ...delta.colorChanged.map((c) => `<li><span class="chg">●</span>${pvLink(idx(c.pv))}<span class="muted">${RISK[c.from]} → ${RISK[c.to]}</span></li>`),
  ];
  return rows.length ? `<ul class="changes">${rows.join("")}</ul>` : `<p class="muted">No dependency changes.</p>`;
}
