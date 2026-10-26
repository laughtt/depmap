export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const RISK = ["green", "amber", "red", "grey"] as const;
export const RISK_LABEL = ["Green · clear", "Amber · watch", "Red · act now", "Unknown"];

const GLYPHS = [
  `<circle cx="6" cy="6" r="4.2" fill="currentColor"/>`,
  `<path d="M6 1.2 11 10.4H1z" fill="currentColor"/><path d="M6 4.6v2.6M6 8.6v.1" stroke="var(--ink)" stroke-width="1.3" stroke-linecap="round"/>`,
  `<path d="M3.9 1h4.2L11 3.9v4.2L8.1 11H3.9L1 8.1V3.9z" fill="currentColor"/><path d="M4.4 4.4l3.2 3.2m0-3.2L4.4 7.6" stroke="var(--ink)" stroke-width="1.3" stroke-linecap="round"/>`,
  `<circle cx="6" cy="6" r="4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 1.6"/>`,
];

export const glyph = (c: number, cls = "") =>
  `<svg class="glyph risk-${RISK[c]} ${cls}" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">${GLYPHS[c]}</svg>`;

export const diamond = `<svg class="glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 1.2 10.8 6 6 10.8 1.2 6z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;

const repoPath = (repo: string) => repo.split("/").map(encodeURIComponent).join("/");
// Next.js-style paths; the repo name is a catch-all segment (group/subgroup/project)
export const paths = {
  repo: (repo: string, snap?: number | null) => `/repos/${repoPath(repo)}${snap ? `/map/${snap}` : ""}`,
  scan: (repo: string, snap: number) => `/repos/${repoPath(repo)}/scans/${snap}`,
};
export function go(url: string) {
  history.pushState(null, "", url);
  dispatchEvent(new PopStateEvent("popstate"));
}

export const num = (n: number) => n.toLocaleString("en-US");
export const shortSha = (s: string) => s.slice(0, 7);

export function ago(iso: string | null | undefined) {
  if (!iso) return "unknown";
  const d = (Date.now() - Date.parse(iso)) / 1000;
  const units: [number, string][] = [[31536000, "y"], [2592000, "mo"], [86400, "d"], [3600, "h"], [60, "m"]];
  for (const [s, u] of units) if (d >= s) return `${Math.floor(d / s)}${u} ago`;
  return "just now";
}

export const date = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const R: Record<string, [string, string]> = {
  malicious: ["Malicious code", `<path d="M8 2.5c-3 0-4.5 2-4.5 4.4 0 1.5.7 2.4 1.5 3V12h6V9.9c.8-.6 1.5-1.5 1.5-3 0-2.4-1.5-4.4-4.5-4.4z"/><circle cx="6.2" cy="7.2" r=".9" fill="currentColor"/><circle cx="9.8" cy="7.2" r=".9" fill="currentColor"/><path d="M7 12v1.5M9 12v1.5"/>`],
  "vuln-high": ["High-severity vulnerability", `<path d="M8 1.8 13 3.6v4c0 3-2.2 5.3-5 6.6-2.8-1.3-5-3.6-5-6.6v-4z"/><path d="M8 5v3.2M8 10.4v.1"/>`],
  vuln: ["Vulnerability", `<path d="M8 1.8 13 3.6v4c0 3-2.2 5.3-5 6.6-2.8-1.3-5-3.6-5-6.6v-4z"/><path d="M5.8 8h4.4"/>`],
  cooldown: ["Too fresh to trust", `<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>`],
  recent: ["Recent release", `<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8h2.6"/>`],
  "takeover-shape": ["Account-takeover shape", `<circle cx="5.5" cy="8" r="2.6"/><path d="M8.1 8H14M12 8v2.2M14 8v1.6"/>`],
  "install-script-added": ["New install script", `<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.8 6.5 1.8 1.5-1.8 1.5M8.4 10h2.8"/>`],
  "new-publisher": ["New publisher", `<circle cx="6.5" cy="5.6" r="2.4"/><path d="M2.5 13.2c.5-2.3 2-3.6 4-3.6s3.5 1.3 4 3.6M12.2 4.2v3.6M10.4 6h3.6"/>`],
  "provenance-dropped": ["Provenance dropped", `<path d="M6.6 9.4 5 11a2.2 2.2 0 0 1-3.1-3.1L3.5 6.3M9.4 6.6 11 5a2.2 2.2 0 0 0-3.1-3.1L6.3 3.5M10 10l3.6 3.6M2.4 2.4 6 6"/>`],
  deprecated: ["Deprecated", `<rect x="2" y="3" width="12" height="3" rx=".8"/><path d="M3 6v6.2c0 .5.4.8.8.8h8.4c.4 0 .8-.3.8-.8V6M6.5 8.6h3"/>`],
  unpublished: ["Unpublished", `<path d="M8 1.8 13.5 4.6v6.8L8 14.2l-5.5-2.8V4.6z" stroke-dasharray="2 1.6"/><path d="m6.2 6.6 3.6 3.6m0-3.6-3.6 3.6"/>`],
  typosquat: ["Look-alike name", `<path d="M2.5 11.5 5 4.5l2.5 7M3.4 9h3.2M9.5 8.2c.7-.8 1.4-.8 2.1 0s1.4.8 2.1 0"/>`],
  unknown: ["Facts unavailable", `<circle cx="8" cy="8" r="5.6" stroke-dasharray="2 1.8"/><path d="M6.6 6.6a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9M8 10.8v.1"/>`],
  "security-post": ["Named in a security post", `<path d="M3 9.8V6.2h2.4L10.5 3v10L5.4 9.8z"/><path d="M5.4 9.8 6.4 13"/><path d="M12.5 6.2a2.6 2.6 0 0 1 0 3.6"/>`],
};

export function reasonIcon(code: string) {
  const [label, path] = R[code.replace(/_/g, "-")] ?? ["Signal", `<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.4M8 10.6v.1"/>`];
  return { label, svg: `<svg class="ricon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>` };
}
