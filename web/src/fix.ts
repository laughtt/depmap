import type { AiFix, CodeFix, CodeSite } from "./api";
import { esc } from "./ui";

// One compact, expandable fix card per risky package: the drawer's Upgrade tab and the per-push page both use it
const MODEL: Record<string, string> = { "claude-haiku-5-5": "Claude Haiku 5.5", "claude-sonnet-5-5": "Claude Sonnet 5.5", "claude-opus-5-5": "Claude Opus 5.5" };
const link = (url: string, text: string) => `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const first = (s: string) => s.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? s;
const section = (title: string, n: number, body: string, open = false) =>
  `<details class="fx-sec"${open ? " open" : ""}><summary>${title}<span class="fx-n">${n}</span></summary><div class="fx-body">${body}</div></details>`;

export const fixPending = (r: CodeFix) => !!r.ai && (r.ai.status === "queued" || r.ai.status === "running");

export const patchOf = (f: AiFix) => f.edits.map((e) => `--- a/${e.file}\n+++ b/${e.file}\n@@ -${e.startLine},${e.endLine - e.startLine + 1} +${e.startLine},${e.after.split("\n").length} @@\n${
  e.before.split("\n").map((l) => `-${l}`).join("\n")}\n${e.after.split("\n").map((l) => `+${l}`).join("\n")}\n`).join("");

function title(r: CodeFix) {
  const a = r.action;
  if (!a) return "No automatic fix";
  if (a.kind === "replace") return `Replace ${r.name}`;
  if (a.kind === "remove") return `Remove ${r.name}`;
  const [from, to] = [r.version.split("."), a.version!.split(".")];
  // on 0.x a minor bump is breaking, so it reads as major
  const bump = from[0] !== to[0] || (from[0] === "0" && from[1] !== to[1]) ? "major" : from[1] !== to[1] ? "minor" : "patch";
  return `${a.kind === "upgrade" ? "Upgrade to" : "Pin"} ${a.version} <span class="fx-bump ${bump}">${a.kind === "pin" ? "older" : bump}</span>`;
}

function verdict(r: CodeFix) {
  const ai = r.ai;
  if (!ai) return "";
  if (fixPending(r)) return `<span class="fx-ai wait"><i></i>AI is checking your code</span>`;
  if (ai.status === "failed" || !ai.fix) return `<span class="fx-ai off">AI check unavailable</span>`;
  const f = ai.fix, optional = f.edits.filter((e) => !e.required).length;
  if (f.needsCodeChange) return `<span class="fx-ai must">Code change required</span>`;
  return `<span class="fx-ai ok">No code change needed${optional ? ` · ${optional} optional` : ""}</span>`;
}

const loc = (file: string, line: number, url?: string) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Open on GitLab">${esc(file)}:${line} ↗</a>` : `${esc(file)}:${line}`);

const site = (s: CodeSite) => `<figure class="fx-code"><figcaption>${loc(s.file, s.line, s.url)}</figcaption><pre>${
  s.snippet.map((l) => `<span${l.line === s.line ? ' class="hit"' : ""}><i>${l.line}</i>${esc(l.text)}</span>`).join("")}</pre>${
  s.calls.length ? `<p>Also line ${s.calls.slice(0, 4).map((c) => `${c.line}${c.name === "()" ? "" : ` <code>.${esc(c.name)}</code>`}`).join(", ")}</p>` : ""}</figure>`;

function edits(f: AiFix) {
  return f.edits.map((e) => `<figure class="fx-code"><figcaption>${loc(e.file, e.startLine, e.url)}<span class="fx-tag ${e.required ? "must" : ""}">${e.required ? "required" : "optional"}</span></figcaption>
    <pre>${e.before.split("\n").map((l, k) => `<del><i>${e.startLine + k}</i>${esc(l)}</del>`).join("")}${e.after.split("\n").map((l) => `<ins><i>+</i>${esc(l)}</ins>`).join("")}</pre>
    <p>${esc(first(e.why))}</p></figure>`).join("")
    + `<div class="fx-row"><button class="btn small copy-patch" data-patch="${esc(patchOf(f))}">Copy patch</button><span class="fx-meta">${MODEL[f.model] ?? esc(f.model)} · ${f.confidence} confidence · $${f.costUsd.toFixed(3)}</span></div>`
    + (f.risks.length ? `<details class="fx-risks"><summary>Check before merging (${f.risks.length})</summary><ul class="fx-list">${f.risks.map((x) => `<li>${esc(first(x))}</li>`).join("")}</ul></details>` : "");
}

export function fixPanel(r: CodeFix) {
  const pj = r.action?.packageJson, f = r.ai?.fix;
  const required = !!f?.edits.some((e) => e.required);
  const sources = [...r.sources, ...(f?.sources ?? [])].filter((s, k, all) => all.findIndex((x) => x.url === s.url) === k);
  return `<div class="fx" data-fix="${esc(r.pv)}">
    <div class="fx-head"><b>${title(r)}</b>${verdict(r)}${r.mrUrl ? `<a class="fx-mr" href="${esc(r.mrUrl)}" target="_blank" rel="noopener">Fix merge request ↗</a>` : ""}</div>
    ${r.usedBy !== r.name ? `<p class="fx-via">Comes in through <code>${esc(r.usedBy)}</code></p>` : ""}
    ${pj ? `<pre class="fx-pj"><span>package.json</span>${pj.before ? `<del>${esc(pj.before)}</del>` : ""}<ins>${esc(pj.after)}</ins></pre>` : ""}
    ${f?.edits.length ? section(required ? "Code change" : "Optional code change", f.edits.length, edits(f), required) : ""}
    ${f && !f.edits.length ? `<p class="fx-note">${esc(first(f.summary))}</p>` : ""}
    ${section("Used in your code", r.usedIn.length, r.usedIn.length ? r.usedIn.slice(0, 4).map(site).join("") : `<p>No scanned file imports <code>${esc(r.usedBy)}</code>.</p>`)}
    ${section("Why", r.why.length, `<ul class="fx-list">${r.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>`)}
    ${r.alternatives.length ? section(`Instead of ${esc(r.alternatives[0].for)}`, r.alternatives.length, `<ul class="fx-list">${r.alternatives.slice(0, 4).map((a) => `<li><b>${esc(a.name)}</b> ${a.url ? link(a.url, "docs") : ""}${a.example ? `<pre>${esc(a.example)}</pre>` : ""}</li>`).join("")}</ul>`) : ""}
    ${sources.length ? section("Sources", sources.length, `<ul class="fx-list">${sources.map((s) => `<li>${link(s.url, s.label)}</li>`).join("")}</ul>`) : ""}
  </div>`;
}

export function bindCopy(root: HTMLElement) {
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".copy-patch");
    if (b) navigator.clipboard.writeText(b.dataset.patch!).then(() => (b.textContent = "Copied"));
  });
}
