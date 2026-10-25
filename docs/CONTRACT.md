# Interface contract

Three parts are built in parallel: the Rust/WASM graph core, the web UI and the server. This file is the single source of truth for how they talk. Change it only with all three in mind.

## 1. Graph binary (`GET /api/graphs/:lockfileSha.bin`)
This file is immutable per lockfile hash and is served with `Cache-Control: public, max-age=31536000, immutable`. It is little-endian.

| Offset | Type | Field |
|---|---|---|
| 0 | 4 bytes | magic `DMAP` |
| 4 | u16 | version = 1 |
| 6 | u16 | reserved = 0 |
| 8 | u32 | N (nodes) |
| 12 | u32 | E (edges) |
| 16 | u32 | namesLen (bytes) |
| 20 | u8[N] | depth (min BFS depth from the root; 255 = unreachable) |
| … | u8[N] | static flags: 1 = direct, 2 = dev, 4 = installScript, 8 = optional, 128 = root |
| … | pad | zero bytes until the offset is a multiple of 4 |
| … | u32[N] | pathCount (number of distinct root→node paths, saturating at 2^32−1) |
| … | u32[E] | edgeFrom (parent node index) |
| … | u32[E] | edgeTo (child node index) |
| … | u8[namesLen] | UTF-8 names `name@version`, N entries joined by `\n` |

Node 0 is always the root, the app itself (`<app>@<version>`). The order of the other nodes is arbitrary but fixed for a given lockfile hash.

## 2. Snapshot state (`GET /api/snapshots/:id/state`)
Colours and dynamic flags change over time, as advisories land and decisions are made, so they are **not** part of the immutable binary:
```json
{ "snapshotId": 12, "lockfileSha": "…", "asOf": "2026-10-25T20:00:00Z",
  "color": "<base64 u8[N]>", "flags": "<base64 u8[N]>",
  "counts": { "total": 412, "red": 3, "amber": 17, "green": 380, "grey": 12 } }
```
- **color:** 0 = green, 1 = amber, 2 = red, 3 = grey (unknown).
- **dynamic flags:** 1 = vuln, 2 = malicious, 4 = deprecated, 8 = decided (accepted or pinned), 16 = changedInDelta, 32 = recent (<72 hours), 64 = fingerprintMatch.

## 3. WASM API (crate `graph_core`, wasm-bindgen)
```ts
class Graph {
  static fromBytes(bytes: Uint8Array): Graph;           // throws on a bad magic or version
  nodeCount(): number; edgeCount(): number;
  name(i: number): string;                              // "name@version"
  depth(i: number): number;
  layout(radius: number): Float32Array;                 // 2N floats: x0, y0, x1, y1, …; root at (0, 0)
  primaryParents(): Uint32Array;                        // N entries; 0xFFFFFFFF for the root or unreachable
  pathsToRoot(node: number): Uint32Array;               // edge indices on ANY root→node path
  descendants(node: number): Uint32Array;               // node indices reachable from node (itself excluded)
  search(query: string, limit: number): Uint32Array;    // case-insensitive substring match on the name
  edgeFrom(): Uint32Array; edgeTo(): Uint32Array;
  flags(): Uint8Array;                                  // static flags per node (§1)
  pathCounts(): Uint32Array;                            // pathCount per node (§1)
}
function diff(a: Graph, b: Graph): Uint8Array;          // per node of b: 0 same, 1 added, 2 upgraded
function removed(a: Graph, b: Graph): Uint32Array;      // indices in a whose package NAME is absent from b
```
The JS side uses camelCase names through `#[wasm_bindgen(js_name = …)]`.

### Layout (deterministic, stable)
1. **Primary parent:** the parent with the smallest depth. Ties go to the lexicographically smallest name.
2. **Spanning tree:** the primary parents form a tree. Within each parent, children are sorted by name.
3. **Angles:** the root's children (the direct dependencies) share 2π in name order. Each child's span is proportional to the size of its spanning subtree. Each node splits its own span among its children the same way.
4. **Placement:** a node sits at the centre of its span, at radius `r = depth * radius / maxDepth`. Siblings get a small radial jitter so dense rings don't collapse: `(k % 3 - 1) * 0.18 * ringGap`, where `k` is the sibling index.
5. **Unreachable nodes** are placed on an outer ring at `radius * 1.08`, spaced evenly in name order.
6. **Stability:** adding one node must not move any node of a *different* wedge by more than 2° of angle when N ≥ 200.

## 4. REST API (JSON unless stated)
- `GET /api/health` returns `{ok: true}`.
- `GET /api/repos` returns `[{repo, snapshots, latest: {id, commitSha, ref, createdAt, counts}}]`.
- `GET /api/repos/:repo/snapshots` returns `[{id, commitSha, ref, createdAt, lockfileSha, counts, mrIid}]`, oldest first. `:repo` is URL-encoded (`group/project`).
- `GET /api/snapshots/:id/state` returns the shape in §2.
- `GET /api/snapshots/:id/delta` returns `{baseSnapshotId, added: [pv], removed: [pv], upgraded: [{name, from, to}], colorChanged: [{pv, from, to}], advice: [Advice]}`.
- `GET /api/pv?pv=name@version&snapshot=<id>` returns:
  ```json
  { "pv": "chalk@5.6.1", "name": "chalk", "version": "5.6.1", "color": 2,
    "reasons": [{ "code": "malicious", "severity": "red", "text": "…", "url": "https://osv.dev/vulnerability/MAL-…" }],
    "fingerprint": { "id": "chalk-debug-2025", "title": "…", "matched": 3, "total": 4,
                     "signals": [{ "id": "…", "label": "…", "hit": true }], "url": "…", "summary": "…" } ,
    "facts": { "publishedAt": "…", "publisher": "…", "maintainers": ["…"], "installScripts": ["postinstall"],
               "provenance": false, "deprecated": null, "license": "MIT", "unpublished": false },
    "advisories": [{ "id": "MAL-…", "kind": "malicious", "summary": "…", "severity": "CRITICAL", "url": "…" }],
    "upgrade": null, "decision": null }
  ```
  `upgrade` is an Advice object when the package changed in this snapshot.
- `POST /api/decisions` takes `{repo, pv, action: "accept" | "pin", reason, expiresAt?, by}` and returns `{ok, decision}`.
- `GET /api/events?repo=` returns `[{id, at, kind, repo, pv, payload}]`, newest first.
- `POST /api/scan` takes `{repo, ref, commitSha, baseSha?, mrIid?, lockfile, packageJson, sources?: [{path, content}], asOf?}` and returns `{snapshotId, lockfileSha, counts, delta?, advice, gate: {pass, undecidedReds: [pv]}}`.
- `POST /api/refresh` takes `{asOf?}` and returns `{flipped: [{pv, from, to, repos}]}`.
- **Connector** (the token stays on the server, encrypted with AES-256-GCM using `APP_SECRET`):
  - `POST /api/connections` takes `{gitlabUrl, token}` and returns `{id, gitlabUrl, user: {username, name, avatarUrl}}`.
  - `GET /api/connections` returns `[{id, gitlabUrl, username}]`.
  - `GET /api/connections/:id/projects` returns `[{id, pathWithNamespace, defaultBranch, webUrl, lastActivityAt}]`.
  - `POST /api/connections/:id/import` takes `{projectId, ref?}` and returns `{repo, snapshotId}`. It fetches `package-lock.json`, `package.json` and the JS/TS sources through the GitLab API, then runs a scan.
  - `GET /api/oauth/start?gitlabUrl=` redirects with PKCE. `GET /api/oauth/callback` creates the connection, then redirects to `/#/connected/:id`.

### Advice object
```json
{ "package": "chalk", "from": "4.1.2", "to": "5.3.0", "direct": true,
  "verdict": "NEEDS_CHANGE",
  "summary": "chalk 5 is ESM-only; 2 call sites use require().",
  "items": [{ "file": "src/log.js", "line": 1, "code": "const chalk = require('chalk')",
              "problem": "…", "fix": "…", "alternatives": ["…"] }],
  "evidence": [{ "kind": "module_format", "text": "…", "url": "…" }],
  "paths": [["shop", "chalk"]] }
```
`verdict` is one of `NEEDS_CHANGE`, `REVIEW`, `NO_CHANGE` or `PATH_ONLY`.

## 5. Colours (rules v1)
- **Red:**
  - an OSV `MAL-` record;
  - a high or critical vulnerability with a fixed version available;
  - the takeover shape: a version under 48 hours old **and** at least one of a new publisher, provenance dropped or a new install script.
- **Amber:**
  - a version under 72 hours old;
  - an install script added since the previous version;
  - a new publisher compared with the previous version;
  - deprecated;
  - a moderate or low vulnerability;
  - an unpublished version (gone from the registry);
  - a name one edit away from a popular package.
- **Green:** none of the above.
- **Grey:** facts unavailable.

Every reason carries a URL to its source record.
