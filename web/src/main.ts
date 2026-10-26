import "./styles.css";
import { commitScreen } from "./commit";
import { connectScreen, loginScreen } from "./connect";
import { homeScreen } from "./home";
import { watchersScreen } from "./watchers";
import { worldScreen } from "./world";
import { isMock } from "./api";
import { go, paths } from "./ui";
import { dm, mapScreen, renderScreen, session, type MapScreen } from "./view";

const root = document.getElementById("app")!;
let screen: MapScreen | null = null;
let world: Awaited<ReturnType<typeof worldScreen>> = null;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  store.set("depmap-theme", t);
  if (dm.map) { dm.map.readPalette(); dm.map.refresh(); }
  world?.repaint();
}
setTheme(store.get("depmap-theme") ?? "dark");

dm.point = (i: number) => {
  const r = dm.map.el.getBoundingClientRect(), v = dm.map.viewport(i);
  return { x: r.left + v.x, y: r.top + v.y };
};
dm.firstWithColor = (c: number) => dm.map.color.findIndex((v: number, i: number) => i > 0 && v === c);
dm.reds = () => [...dm.map.color.keys()].filter((i) => i > 0 && dm.map.color[i] === 2).sort((a, b) => (dm.map.dyn[b] & 64) - (dm.map.dyn[a] & 64));

// links from before the paths: #/repo/<repo>/<snap>, #/c/<repo>/<snap>, #/watchers?repo=…
if (location.hash.startsWith("#/")) {
  const [p, qs = ""] = location.hash.slice(1).split("?");
  const seg = p.split("/").filter(Boolean), last = seg[seg.length - 1];
  const snap = /^\d+$/.test(last) && seg.length > 2 ? +last : null;
  const repo = decodeURIComponent((snap === null ? seg.slice(1) : seg.slice(1, -1)).join("/"));
  const to = seg[0] === "repo" ? paths.repo(repo, snap) : seg[0] === "c" ? (snap ? paths.scan(repo, snap) : paths.repo(repo)) : p;
  const search = new URLSearchParams(location.search);
  new URLSearchParams(qs).forEach((v, k) => search.set(k, v));
  history.replaceState(null, "", `${to}${search.size ? `?${search}` : ""}`);
}

async function route() {
  const params = new URLSearchParams(location.search);
  const seg = location.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  document.documentElement.classList.toggle("chromeless", seg[0] === "render");
  if (session.loginRequired && !session.user && seg[0] !== "render") return loginScreen(root);
  // /repos/<repo…>, /repos/<repo…>/map/<snap>, /repos/<repo…>/scans/<snap>
  const [kind, id] = seg.slice(-2);
  const snap = seg[0] === "repos" && seg.length > 3 && (kind === "map" || kind === "scans") && /^\d+$/.test(id) ? +id : null;
  const repo = (snap === null ? seg.slice(1) : seg.slice(1, -2)).join("/");
  const scanPage = snap !== null && kind === "scans";
  if (seg[0] === "repos" && repo && !scanPage) {
    if (screen?.repo === repo && snap !== null) return screen.setSnapshot(snap);
    screen?.destroy();
    screen = await mapScreen(root, repo, snap, { dig: params.get("dig") === "1", focus: params.get("focus") });
    return;
  }
  screen?.destroy();
  screen = null;
  dm.map = null;
  world?.destroy();
  world = null;
  if (scanPage) return commitScreen(root, repo, snap);
  if (seg[0] === "connect") return connectScreen(root);
  if (seg[0] === "connected") return connectScreen(root, seg[1]);
  if (seg[0] === "render") return renderScreen(root, params);
  if (seg[0] === "watchers") return watchersScreen(root, params);
  if (seg[0] === "world") { world = await worldScreen(root, params.get("focus")); return; }
  homeScreen(root);
}

addEventListener("popstate", route);
// in-app links change the path without a reload
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target || a.hasAttribute("download")) return;
  if (a.origin !== location.origin || a.getAttribute("href")!.startsWith("#") || /^\/(api|ci)\//.test(a.pathname)) return;
  e.preventDefault();
  if (a.pathname + a.search !== location.pathname + location.search) go(a.pathname + a.search);
});
document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".theme")) setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  document.querySelectorAll("details.user-menu[open]").forEach((d) => d.contains(e.target as Node) || d.removeAttribute("open"));
});
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  screen?.keys(e);
});
if (!(await isMock())) Object.assign(session, await fetch("/api/me").then((r) => r.json()).catch(() => ({})));
route();
