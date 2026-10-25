import "./styles.css";
import { connectScreen } from "./connect";
import { homeScreen } from "./home";
import { watchersScreen } from "./watchers";
import { dm, mapScreen, renderScreen, type MapScreen } from "./view";

const root = document.getElementById("app")!;
let screen: MapScreen | null = null;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};

function setTheme(t: string) {
  document.documentElement.dataset.theme = t;
  store.set("depmap-theme", t);
  if (dm.map) { dm.map.readPalette(); dm.map.refresh(); }
}
setTheme(store.get("depmap-theme") ?? "dark");

dm.point = (i: number) => {
  const r = dm.map.el.getBoundingClientRect(), v = dm.map.viewport(i);
  return { x: r.left + v.x, y: r.top + v.y };
};
dm.firstWithColor = (c: number) => dm.map.color.findIndex((v: number, i: number) => i > 0 && v === c);
dm.reds = () => [...dm.map.color.keys()].filter((i) => i > 0 && dm.map.color[i] === 2).sort((a, b) => (dm.map.dyn[b] & 64) - (dm.map.dyn[a] & 64));

async function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const seg = path.split("/").filter(Boolean);
  document.documentElement.classList.toggle("chromeless", seg[0] === "render");
  if (seg[0] === "repo" && seg.length > 1) {
    const last = seg[seg.length - 1], snap = /^\d+$/.test(last) && seg.length > 2 ? +last : null;
    const repo = decodeURIComponent((snap === null ? seg.slice(1) : seg.slice(1, -1)).join("/"));
    if (screen?.repo === repo && snap !== null) return screen.setSnapshot(snap);
    screen?.destroy();
    screen = await mapScreen(root, repo, snap, { dig: params.get("dig") === "1", focus: params.get("focus") });
    return;
  }
  screen?.destroy();
  screen = null;
  dm.map = null;
  if (seg[0] === "connect") return connectScreen(root);
  if (seg[0] === "connected") return connectScreen(root, seg[1]);
  if (seg[0] === "render") return renderScreen(root, params);
  if (seg[0] === "watchers") return watchersScreen(root, params);
  homeScreen(root);
}

addEventListener("hashchange", route);
document.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".theme")) setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  if (t.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  screen?.keys(e);
});
route();
