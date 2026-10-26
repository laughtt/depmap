import { api, isMock, type Reason, type Snapshot } from "./api";
import { RISK, ago, esc, glyph, num, reasonIcon, shortSha, paths } from "./ui";
import { stateMsg, topbar } from "./view";

function spark(snaps: Snapshot[]) {
  const v = snaps.map((s) => s.counts.red), max = Math.max(1, ...v), w = 120, h = 28;
  const pts = v.map((y, k) => [v.length < 2 ? w : (k * w) / (v.length - 1), h - 3 - (y / max) * (h - 8)]);
  const last = pts[pts.length - 1];
  return `<svg class="spark ${v[v.length - 1] ? "hot" : ""}" viewBox="-3 0 ${w + 6} ${h}" width="${w + 6}" height="${h}" role="img" aria-label="Red packages per snapshot: ${v.join(", ")}">
    <path d="M${pts.map((p) => p.join(",")).join("L")}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="currentColor"/></svg>`;
}

type Blast = { pv: string; color: number; reason: Reason | null; repos: { repo: string; snapshotId: number }[] };
const blastList = async (): Promise<Blast[]> =>
  (await isMock()) ? (await import("./mock")).mockCall("GET", "/api/blast", null) as Promise<Blast[]> : fetch("/api/blast").then((r) => (r.ok ? r.json() : []));

// one risky package@version and every repository whose latest scan contains it
function blast(rows: Blast[]) {
  if (!rows.length) return "";
  const repos = new Set(rows.flatMap((b) => b.repos.map((r) => r.repo))).size;
  return `<section class="blast" aria-label="Blast radius"><header><h2>Blast radius</h2><p>${rows.length} risky ${rows.length === 1 ? "version" : "versions"} in ${repos} repositories</p></header>
    <ul>${rows.map((b) => {
      const at = b.pv.lastIndexOf("@"), why = b.reason && reasonIcon(b.reason.code);
      return `<li class="risk-${RISK[b.color]}"><div class="bl-pv">${glyph(b.color)}<b>${esc(b.pv.slice(0, at))}</b><code>${esc(b.pv.slice(at + 1))}</code></div>
        ${why ? `<p class="bl-why" title="${esc(b.reason!.text)}">${why.svg}<span><b>${why.label}.</b> ${esc(b.reason!.text)}</span></p>` : ""}
        <div class="bl-repos">${b.repos.map((r) => `<a href="${paths.scan(r.repo, r.snapshotId)}">${esc(r.repo)}</a>`).join("")}</div></li>`;
    }).join("")}</ul></section>`;
}

export async function homeScreen(root: HTMLElement) {
  root.innerHTML = `<div class="screen plain-screen">
    <header class="topbar">${topbar("repos")}</header>
    <main class="home"><div class="page-head"><div><h1>Repositories</h1><p>Every connected project with its latest scan. Red counts packages to act on now.</p></div><a class="btn primary" href="/connect">Connect a repository</a></div><div class="repo-grid"><div class="repo-card skeleton-card"></div><div class="repo-card skeleton-card"></div></div></main></div>`;
  const grid = root.querySelector<HTMLElement>(".repo-grid")!;
  blastList().then((rows) => grid.insertAdjacentHTML("beforebegin", blast(rows))).catch(() => {});
  try {
    const repos = await api.repos();
    if (!repos.length) {
      grid.outerHTML = stateMsg("No repositories yet.", "Connect GitLab and import a project to see its dependency map.", `<a class="btn primary" href="/connect">Connect a repository</a>`);
      return;
    }
    const all = await Promise.all(repos.map((r) => api.snapshots(r.repo).catch(() => [] as Snapshot[])));
    grid.innerHTML = repos.map((r, k) => {
      const c = r.latest.counts;
      return `<a class="repo-card" href="${paths.repo(r.repo, r.latest.id)}">
        <div class="rc-top"><b>${esc(r.repo)}</b><span class="faint">${esc(r.latest.ref)} <code>${shortSha(r.latest.commitSha)}</code></span></div>
        <div class="rc-mid">${all[k].length ? spark(all[k]) : ""}<div class="rc-reds">${glyph(2)}<b>${num(c.red)}</b><span>red now</span></div></div>
        <div class="bar" aria-hidden="true">${[2, 1, 3, 0].map((x) => `<i class="risk-${RISK[x]}" style="flex:${c[RISK[x]]}"></i>`).join("")}</div>
        <div class="rc-foot"><span>${num(c.total)} packages</span><span>${glyph(1)}${num(c.amber)}</span><span>${glyph(3)}${num(c.grey)}</span><span class="faint">${r.snapshots} snapshots · scanned ${ago(r.latest.createdAt)}</span></div>
      </a>`;
    }).join("") + `<a class="repo-card add" href="/connect"><span class="plus" aria-hidden="true">+</span><b>Connect a repository</b><span class="faint">Import any GitLab project with an npm or pnpm lockfile</span></a>`;
  } catch (e) {
    grid.outerHTML = stateMsg("Repositories didn't load.", esc((e as Error).message), `<button class="btn" onclick="location.reload()">Try again</button>`);
  }
}
