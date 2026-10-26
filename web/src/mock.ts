import { ApiError, bigMock, type Advice, type Counts, type Decision, type Delta, type DepEvent, type PvDetail, type Snapshot } from "./api";
import { F, parseBin, pvName, pvVersion, type Bin } from "./graph";

const GRAPHS: Record<string, string> = { "demo-small": "/demo/small.bin", "synthetic-50k": "/demo/synthetic-50k.bin" };
const REPOS: Record<string, string> = { "demo/shop": "demo-small", ...(bigMock ? { "synthetic/monorepo-50k": "synthetic-50k" } : {}) };
const SNAP_META = [
  { commitSha: "a1c3e9f4b2", ref: "main", kind: "push", asOf: "2025-09-01T09:12:00Z", mrIid: null },
  { commitSha: "b7d20418ce", ref: "main", kind: "push", asOf: "2025-09-05T16:40:00Z", mrIid: null },
  { commitSha: "b7d20418ce", ref: "main", kind: "refresh", asOf: "2025-09-08T13:30:00Z", mrIid: null },
  { commitSha: "d4e8a7105b", ref: "chalk-5", kind: "mr", asOf: "2025-09-09T10:05:00Z", mrIid: 42 },
].map((m) => ({ ...m, kind: m.kind as Snapshot["kind"], createdAt: m.asOf }));
const WATCH_SOURCES = [
  ["github-malware", "GitHub malware advisories", "ghsa", "https://github.com/advisories?query=type%3Amalware"],
  ["aikido", "Aikido Security research", "rss", "https://www.aikido.dev/blog"],
  ["stepsecurity", "StepSecurity blog", "rss", "https://www.stepsecurity.io/blog"],
  ["wiz", "Wiz research", "rss", "https://www.wiz.io/blog"],
  ["snyk", "Snyk blog", "rss", "https://snyk.io/blog/"],
  ["openssf", "OpenSSF blog", "rss", "https://openssf.org/blog/"],
  ["cisa", "CISA advisories", "rss", "https://www.cisa.gov/news-events/cybersecurity-advisories"],
] as const;
let polls = 0;
const D = { vuln: 1, malicious: 2, deprecated: 4, decided: 8, changed: 16, recent: 32, fingerprint: 64 };

export const mockGraphUrl = (sha: string) => GRAPHS[sha] ?? GRAPHS["demo-small"];

type Scenario = {
  bin: Bin; repo: string; sha: string; snaps: { color: Uint8Array; flags: Uint8Array }[];
  chalk: number; mal: number[]; vuln: number; added: number[]; removed: string[]; patch: number; transitive: number; parent: Int32Array;
};
const scenarios = new Map<string, Promise<Scenario>>();
const decisions = new Map<string, Decision>();

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function scenario(repo: string): Promise<Scenario> {
  if (!scenarios.has(repo)) scenarios.set(repo, build(repo));
  return scenarios.get(repo)!;
}

async function build(repo: string): Promise<Scenario> {
  const sha = REPOS[repo];
  if (!sha) throw new ApiError(404, `Repository ${repo} is not known`);
  const bin = parseBin(new Uint8Array(await (await fetch(GRAPHS[sha])).arrayBuffer()));
  const { n, names, depth, flags } = bin;
  const rnd = rng(7);
  const find = (pkg: string) => names.findIndex((s, i) => i > 0 && pvName(s) === pkg);
  const pick = (ok: (i: number) => boolean) => {
    for (let k = 0; k < 5000; k++) { const i = 1 + Math.floor(rnd() * (n - 1)); if (ok(i)) return i; }
    return Math.min(1, n - 1);
  };
  const deep = (i: number) => depth[i] >= 2 && depth[i] !== 255;
  const direct = (i: number) => (flags[i] & F.direct) > 0;
  const chalk = find("chalk") > 0 ? find("chalk") : pick(direct);
  const mal = ["debug", "ansi-styles", "supports-color", "strip-ansi", "color-convert"].map(find).filter((i) => i > 0 && i !== chalk).slice(0, 3);
  while (mal.length < 3) mal.push(pick((i) => deep(i) && !mal.includes(i) && i !== chalk));
  const vuln = pick((i) => deep(i) && !mal.includes(i) && i !== chalk);
  const added = [pick(deep), pick(deep)];
  const patch = pick((i) => direct(i) && i !== chalk);
  const transitive = pick((i) => deep(i) && !mal.includes(i));

  const color = new Uint8Array(n), dyn = new Uint8Array(n);
  for (let i = 1; i < n; i++) {
    const r = rnd();
    if (r < 0.045) { color[i] = 1; dyn[i] = r < 0.02 ? D.recent : D.deprecated; }
    else if (r < 0.06) color[i] = 3;
  }
  const s1 = { color: color.slice(), flags: dyn.slice() };
  s1.color[vuln] = 2; s1.flags[vuln] = D.vuln;
  const s2 = { color: s1.color.slice(), flags: s1.flags.slice() };
  let flipped = 0;
  for (let i = 1; i < n && flipped < Math.max(2, n / 200); i++) if (s2.flags[i] === D.recent) { s2.color[i] = 0; s2.flags[i] = 0; flipped++; }
  const fresh = pick((i) => s2.color[i] === 0);
  s2.color[fresh] = 1; s2.flags[fresh] = D.recent;
  const s3 = { color: s2.color.slice(), flags: s2.flags.slice() };
  for (const i of mal) { s3.color[i] = 2; s3.flags[i] = D.malicious | D.recent | D.fingerprint; }
  const s4 = { color: s3.color.slice(), flags: s3.flags.slice() };
  for (const i of [chalk, ...added, patch]) s4.flags[i] |= D.changed;
  s4.color[chalk] = 0;
  const present = new Set(names.map(pvName));
  const removed = ["has-flag@4.0.0", "supports-color@7.2.0", "left-pad@1.3.0", "inherits@2.0.3"].filter((x) => !present.has(pvName(x))).slice(0, 2);
  const parent = new Int32Array(n).fill(0);
  for (let e = bin.e - 1; e >= 0; e--) if (depth[bin.edgeFrom[e]] + 1 === depth[bin.edgeTo[e]]) parent[bin.edgeTo[e]] = bin.edgeFrom[e];
  return { bin, repo, sha, snaps: [s1, s2, s3, s4], chalk, mal, vuln, added, removed, patch, transitive, parent };
}

const counts = (c: Uint8Array): Counts => {
  const k = { total: c.length, red: 0, amber: 0, green: 0, grey: 0 };
  for (const v of c) v === 2 ? k.red++ : v === 1 ? k.amber++ : v === 3 ? k.grey++ : k.green++;
  return k;
};

function b64(a: Uint8Array) {
  let s = "";
  for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192));
  return btoa(s);
}

function snapshots(S: Scenario): Snapshot[] {
  return S.snaps.map((s, k) => ({ id: k + 1, ...SNAP_META[k], lockfileSha: S.sha, counts: counts(s.color) }));
}

async function bySnapshot(id: number) {
  const k = ((id - 1) % 4 + 4) % 4;
  const repo = id > 100 ? "synthetic/monorepo-50k" : "demo/shop";
  return { S: await scenario(repo), k, id };
}
const snapId = (repo: string, k: number) => (repo === "demo/shop" ? k + 1 : 101 + k);

function chalkAdvice(S: Scenario): Advice {
  const root = pvName(S.bin.names[0]);
  return {
    package: "chalk", from: "4.1.2", to: "5.3.0", direct: true, verdict: "NEEDS_CHANGE",
    summary: "chalk 5 is ESM-only; 2 call sites use require().",
    items: [
      {
        file: "src/log.js", line: 1, code: "const chalk = require('chalk')",
        problem: "chalk 5 ships only ES modules. On Node below 20.19 this require() throws ERR_REQUIRE_ESM at startup.",
        fix: "import chalk from 'chalk'",
        alternatives: ["Stay on chalk@4.1.2, the last CommonJS release", "Load it lazily: const { default: chalk } = await import('chalk')"],
      },
      {
        file: "src/cli/banner.js", line: 3, code: "const { red, bold } = require('chalk')",
        problem: "chalk 5 has no named colour exports, so destructuring red and bold from the module gives undefined.",
        fix: "import chalk from 'chalk'\nconst { red, bold } = chalk",
        alternatives: ["Switch to node:util styleText(['red', 'bold'], text) on Node 20.12+"],
      },
    ],
    evidence: [
      { kind: "module_format", text: "chalk@5.3.0 package.json sets \"type\": \"module\" and its exports map has no require condition.", url: "https://www.npmjs.com/package/chalk/v/5.3.0?activeTab=code" },
      { kind: "changelog", text: "5.0.0 · Breaking: this package is now pure ESM.", url: "https://github.com/chalk/chalk/releases/tag/v5.0.0" },
      { kind: "usage", text: "2 require('chalk') call sites found in 14 scanned files.", url: "" },
    ],
    paths: [[root, "chalk"]],
  };
}

function deltaFor(S: Scenario, k: number): Delta {
  const names = S.bin.names, prev = S.snaps[k - 1], cur = S.snaps[k];
  const colorChanged: Delta["colorChanged"] = [];
  if (prev) for (let i = 0; i < cur.color.length; i++) if (prev.color[i] !== cur.color[i]) colorChanged.push({ pv: names[i], from: prev.color[i], to: cur.color[i] });
  const d: Delta = { baseSnapshotId: k ? snapId(S.repo, k - 1) : null, added: [], removed: [], upgraded: [], colorChanged, advice: [] };
  if (k !== 3) return d;
  const root = pvName(names[0]), patch = names[S.patch], tr = names[S.transitive];
  const via = (i: number) => { const p: string[] = []; for (let c = i; c >= 0 && p.length < 9; c = c ? S.parent[c] : -1) p.unshift(pvName(names[c])); return p; };
  d.added = S.added.map((i) => names[i]);
  d.removed = S.removed;
  d.upgraded = [
    { name: "chalk", from: "4.1.2", to: "5.3.0" },
    { name: pvName(patch), from: bump(pvVersion(patch), -1), to: pvVersion(patch) },
    { name: pvName(tr), from: bump(pvVersion(tr), -1), to: pvVersion(tr) },
  ];
  d.advice = [
    chalkAdvice(S),
    { package: pvName(patch), from: bump(pvVersion(patch), -1), to: pvVersion(patch), direct: true, verdict: "NO_CHANGE",
      summary: `Patch release; the 3 symbols you use from ${pvName(patch)} keep their signatures.`, items: [],
      evidence: [{ kind: "api_diff", text: "No removed or changed exports between the two .d.ts files.", url: "" }], paths: [[root, pvName(patch)]] },
    { package: pvName(tr), from: bump(pvVersion(tr), -1), to: pvVersion(tr), direct: false, verdict: "PATH_ONLY",
      summary: `No code change; reaches you via ${via(S.transitive).join(" → ")}.`, items: [], evidence: [], paths: [via(S.transitive)] },
  ];
  return d;
}

function bump(v: string, dir: number) {
  const p = v.split(".").map((x) => parseInt(x) || 0);
  if (p.length < 3) return v;
  p[2] = Math.max(0, p[2] + dir);
  if (dir < 0 && p[2] === parseInt(v.split(".")[2])) p[1] = Math.max(0, p[1] - 1);
  return p.join(".");
}

function pvDetail(S: Scenario, k: number, pv: string): PvDetail {
  const i = S.bin.names.indexOf(pv);
  if (i < 0) throw new ApiError(404, `${pv} is not in this snapshot`);
  const s = S.snaps[k], c = s.color[i], f = s.flags[i];
  const name = pvName(pv), version = pvVersion(pv);
  const npm = `https://www.npmjs.com/package/${name}/v/${version}`;
  const osv = `https://osv.dev/list?ecosystem=npm&q=${encodeURIComponent(name)}`;
  const d: PvDetail = {
    pv, name, version, color: c, reasons: [], fingerprint: null, advisories: [], upgrade: null,
    decision: decisions.get(`${S.repo}|${pv}`) ?? null,
    facts: {
      publishedAt: f & D.recent ? "2025-09-08T13:16:00Z" : "2024-03-11T08:02:00Z",
      publisher: f & D.malicious ? "qix" : "sindresorhus", maintainers: ["qix", "sindresorhus"],
      installScripts: S.bin.flags[i] & F.install ? ["postinstall"] : [], provenance: f & D.malicious ? false : true,
      deprecated: f & D.deprecated ? "This version is no longer maintained; upgrade to the next major." : null,
      license: "MIT", unpublished: false,
    },
  };
  if (f & D.malicious) {
    d.reasons.push({ code: "malicious", severity: "red", text: "An OSV malicious-package record covers this exact version. The published code hooks browser fetch and wallet APIs to rewrite crypto addresses.", url: osv });
    d.reasons.push({ code: "takeover-shape", severity: "red", text: "Published 14 minutes before the scan, without the provenance its previous versions had.", url: npm });
    d.advisories.push({ id: "MAL-DEMO-0908", kind: "malicious", summary: `Malicious code in ${pv}`, severity: "CRITICAL", url: osv });
    d.fingerprint = {
      id: "chalk-debug-2025", title: "Looks like chalk/debug, September 2025", matched: 3, total: 4,
      url: "https://osv.dev/list?ecosystem=npm&q=debug",
      summary: "A phished maintainer account pushed patch releases of 18 popular packages within an hour. The payload ran in browsers and swapped wallet addresses.",
      signals: [
        { id: "fresh", label: "Version published less than 48 hours ago", hit: true },
        { id: "provenance", label: "Provenance dropped compared with the previous version", hit: true },
        { id: "burst", label: "Same publisher released many packages within an hour", hit: true },
        { id: "install", label: "New install script", hit: false },
      ],
    };
  } else if (f & D.vuln) {
    d.reasons.push({ code: "vuln-high", severity: "red", text: `High-severity prototype pollution, fixed in ${bump(version, 1)}.`, url: osv });
    d.advisories.push({ id: "GHSA-DEMO-p7x2", kind: "vuln", summary: "Prototype pollution in merge()", severity: "HIGH", url: osv });
  } else if (f & D.recent && c === 1) {
    d.reasons.push({ code: "cooldown", severity: "amber", text: "Published 3 days ago, still inside the 7-day cooldown.", url: npm });
  } else if (f & D.deprecated) {
    d.reasons.push({ code: "deprecated", severity: "amber", text: `Deprecated by its maintainer: "${d.facts.deprecated}"`, url: npm });
  } else if (c === 3) {
    d.reasons.push({ code: "unknown", severity: "grey", text: "Registry facts unavailable: deps.dev timed out during the scan.", url: `https://deps.dev/npm/${encodeURIComponent(name)}` });
    d.facts.publishedAt = null; d.facts.publisher = null; d.facts.provenance = null;
  }
  if (i === S.chalk && k === 3) d.upgrade = chalkAdvice(S);
  return d;
}

const PROJECTS = [
  { id: 7, pathWithNamespace: "demo/shop", defaultBranch: "main", webUrl: "http://localhost:8929/demo/shop", lastActivityAt: "2025-09-09T10:05:00Z" },
  { id: 8, pathWithNamespace: "demo/storefront-api", defaultBranch: "main", webUrl: "http://localhost:8929/demo/storefront-api", lastActivityAt: "2025-09-07T12:00:00Z" },
  { id: 9, pathWithNamespace: "platform/auth-gateway", defaultBranch: "main", webUrl: "http://localhost:8929/platform/auth-gateway", lastActivityAt: "2025-08-30T18:22:00Z" },
  { id: 10, pathWithNamespace: "platform/billing-worker", defaultBranch: "develop", webUrl: "http://localhost:8929/platform/billing-worker", lastActivityAt: "2025-08-21T09:41:00Z" },
  { id: 11, pathWithNamespace: "tools/release-bot", defaultBranch: "main", webUrl: "http://localhost:8929/tools/release-bot", lastActivityAt: "2025-07-02T15:10:00Z" },
];

export async function mockCall(method: string, path: string, body: any): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60));
  const [p, q] = path.split("?");
  const params = new URLSearchParams(q);
  let m: RegExpMatchArray | null;
  if (p === "/api/health") return { ok: true };
  if (p === "/api/repos") {
    return Promise.all(Object.keys(REPOS).map(async (repo) => {
      const list = snapshots(await scenario(repo)), latest = list[list.length - 1];
      return { repo, snapshots: list.length, latest: { ...latest, id: snapId(repo, 3) } };
    }));
  }
  if (p === "/api/blast") {
    const text = "MAL-2025-46969: debug 4.4.2 was published from a phished maintainer account with a browser crypto-stealer.";
    return [{ pv: "debug@4.4.2", color: 2, reason: { code: "malicious", severity: "red", text, url: "https://osv.dev/vulnerability/MAL-2025-46969" }, repos: [{ repo: "demo/admin", snapshotId: 104 }, { repo: "demo/shop", snapshotId: snapId("demo/shop", 3) }] }];
  }
  if ((m = p.match(/^\/api\/repos\/(.+)\/snapshots$/))) {
    const repo = decodeURIComponent(m[1]), S = await scenario(repo);
    return snapshots(S).map((s, k) => {
      const pass = !s.counts.red || k < 2;
      return { ...s, id: snapId(repo, k), gate: { pass, undecidedReds: pass ? [] : S.bin.names.filter((_, i) => i > 0 && S.snaps[k].color[i] === 2) } };
    });
  }
  if ((m = p.match(/^\/api\/snapshots\/(\d+)\/(state|delta)$/))) {
    const { S, k, id } = await bySnapshot(+m[1]);
    if (m[2] === "delta") return deltaFor(S, k);
    const s = S.snaps[k];
    return { snapshotId: id, lockfileSha: S.sha, asOf: SNAP_META[k].createdAt, color: b64(s.color), flags: b64(s.flags), counts: counts(s.color) };
  }
  if (p === "/api/pv") {
    const { S, k } = await bySnapshot(+(params.get("snapshot") ?? 1));
    return pvDetail(S, k, params.get("pv") ?? "");
  }
  if (p === "/api/decisions" && method === "POST") {
    const d: Decision = { ...body, createdAt: new Date().toISOString() };
    decisions.set(`${d.repo}|${d.pv}`, d);
    return { ok: true, decision: d };
  }
  if (p === "/api/events") {
    const repo = params.get("repo") ?? "demo/shop", S = await scenario(repo), names = S.bin.names;
    const ev: DepEvent[] = [
      { id: 5, snapshotId: snapId(repo, 3), at: "2025-09-09T10:05:00Z", kind: "upgrade", repo, pv: "chalk@5.3.0", payload: { title: "MR !42 bumps chalk 4.1.2 → 5.3.0" } },
      { id: 4, snapshotId: snapId(repo, 2), at: "2025-09-08T13:30:00Z", kind: "advisory", repo, pv: names[S.mal[0]], payload: { title: `Malicious-package records for ${S.mal.map((i) => pvName(names[i])).join(", ")}` } },
      { id: 3, snapshotId: snapId(repo, 1), at: "2025-09-06T08:00:00Z", kind: "cooldown", repo, pv: null, payload: { title: "Cooldown ended for 2 packages" } },
      { id: 2, snapshotId: snapId(repo, 0), at: "2025-09-03T11:20:00Z", kind: "advisory", repo, pv: names[S.vuln], payload: { title: `High-severity advisory for ${pvName(names[S.vuln])}` } },
      { id: 1, snapshotId: snapId(repo, 0), at: "2025-09-01T09:12:00Z", kind: "scan", repo, pv: null, payload: { title: "Baseline scan" } },
    ];
    return ev;
  }
  if (p === "/api/watchers/poll" && method === "POST") { polls++; return { ok: true }; }
  if (p === "/api/watchers") {
    const now = Date.now();
    return { lastPoll: new Date(now - (polls ? 2000 : 180000)).toISOString(), sources: WATCH_SOURCES.map(([id, name, kind, url], k) => ({ id, name, kind, url, items: [100, 100, 64, 212, 180, 10, 30][k], latest: new Date(now - (k + 1) * 3.1e6 * (k + 1)).toISOString() })) };
  }
  if (p === "/api/watchers/items") {
    const S = await scenario(params.get("repo") ?? "demo/shop"), have = new Set(S.bin.names.map(pvName));
    const h = (x: number) => new Date(Date.now() - x * 36e5).toISOString();
    const items = [
      ...(polls ? [{ src: "github-malware", t: 0.01, title: "Malware in debug", pk: ["debug"], url: "https://github.com/advisories?query=debug", sum: "A compromised maintainer account published a version with a browser crypto-stealer. Treat any machine that built with it as exposed." }] : []),
      { src: "wiz", t: 0.7, title: "Widespread npm supply chain attack: breaking down impact and scope across debug, chalk and beyond", pk: ["debug", "chalk", "ansi-styles", "supports-color", "strip-ansi", "color-convert"], url: "https://www.wiz.io/blog/widespread-npm-supply-chain-attack-breaking-down-impact-scope-across-debug-chalk", sum: "Eighteen packages with over two billion weekly downloads were republished from a phished maintainer account. The payload hooks fetch and wallet APIs in the browser." },
      { src: "aikido", t: 1.4, title: "npm debug and chalk packages compromised", pk: ["debug", "chalk", "color-convert"], url: "https://www.aikido.dev/blog", sum: "Our feed flagged new patch releases of debug and chalk minutes after publish. The code obfuscates a wallet drainer that only runs in browsers." },
      { src: "stepsecurity", t: 5, title: "Install-time credential theft in a typosquat of express middleware", pk: ["expres-session-store"], url: "https://www.stepsecurity.io/blog", sum: "A look-alike package ran a postinstall script that read CI tokens. It was downloaded 1,200 times before removal." },
      { src: "github-malware", t: 9, title: "Malware in sound-cloud-loader-api", pk: ["sound-cloud-loader-api"], url: "https://github.com/advisories?query=type%3Amalware", sum: "Any computer that has this package installed should be considered fully compromised." },
      { src: "snyk", t: 26, title: "Prototype pollution in a popular merge helper, fixed upstream", pk: [pvName(S.bin.names[S.vuln])], url: "https://snyk.io/blog/", sum: "A crafted payload can set properties on Object.prototype. Upgrade to the fixed patch release." },
      { src: "openssf", t: 50, title: "Trusted publishing for npm is now generally available", pk: [], url: "https://openssf.org/blog/", sum: "Packages published through trusted publishing carry provenance that links each tarball to its source commit." },
      { src: "cisa", t: 75, title: "Widespread supply chain compromise impacting npm ecosystem", pk: ["debug", "chalk"], url: "https://www.cisa.gov/news-events/alerts", sum: "CISA urges organisations to review dependencies and rotate credentials exposed to affected builds." },
    ];
    return items.map((x, k) => ({ id: `${x.src}:${k}`, source: x.src, title: x.title, url: x.url, published: h(x.t), summary: x.sum,
      packages: x.pk.map((name) => ({ name, versions: [">= 0"] })), matched: x.pk.filter((n) => have.has(n)) }));
  }
  if (p === "/api/connections" && method === "POST") {
    if (!/^https?:\/\//.test(body?.gitlabUrl ?? "")) throw new ApiError(400, "Enter a GitLab URL that starts with http:// or https://");
    if (String(body?.token).startsWith("bad")) throw new ApiError(401, "GitLab rejected this token. Check that it has the read_api scope.");
    return { id: "c1", gitlabUrl: body.gitlabUrl, user: { username: "mauricio", name: "Mauricio", avatarUrl: "" } };
  }
  if (p === "/api/connections") return [{ id: "c1", gitlabUrl: "http://localhost:8929", username: "mauricio" }];
  if ((m = p.match(/^\/api\/connections\/([^/]+)\/projects$/))) return PROJECTS;
  if ((m = p.match(/^\/api\/connections\/([^/]+)\/import$/))) {
    await new Promise((r) => setTimeout(r, 700));
    const proj = PROJECTS.find((x) => x.id === body?.projectId);
    if (!proj) throw new ApiError(404, "Project not found");
    return { repo: "demo/shop", snapshotId: 4 };
  }
  throw new ApiError(404, `Mock has no route for ${method} ${p}`);
}
