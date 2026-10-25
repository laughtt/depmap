# graph-core

Rust/WASM core for the dependency map: decodes the `DMAP` binary (docs/CONTRACT.md §1) and lays it out (§3). Build with `pnpm build:wasm`, test with `cargo test` (perf: `cargo test --release -- --ignored --nocapture`).

**API:** `Graph.fromBytes(bytes)` (throws on a bad magic, version or length), `nodeCount`, `edgeCount`, `name(i)`, `depth(i)`, `layout(radius)` → `Float32Array` of 2N, `primaryParents`, `pathsToRoot(node)` (edge indices), `descendants(node)`, `search(query, limit)` (ASCII case-insensitive substring), `flags`, `pathCounts`, `edgeFrom`, `edgeTo`; free `diff(a, b)` (per node of b: 0 same, 1 added, 2 upgraded) and `removed(a, b)`, both comparing the package name before the last `@`. Rust only: `encode(...)`, `Graph::decode`, `to_bytes`.

**Layout:** primary parent = the parent with the smallest depth (tie: smallest name), and it must be shallower than the child; children are sorted by name; each node splits its angular span among its children in proportion to their subtree sizes; radius = `depth * radius / maxDepth` plus `(k % 3 - 1) * 0.18 * ringGap` jitter; nodes outside the tree sit on a ring at `radius * 1.08`, spread evenly in name order.

**Measured** (50k nodes / 120k edges from `scripts/gen-graph.mjs --seed 1`, Apple Silicon): layout takes 7 ms cold and 3 ms warm in WASM under Node, and 3 ms natively. Under Node, `pathsToRoot` takes 0.2 ms and `descendants` about 1 ms.

`scripts/gen-graph.mjs` also exports `encodeGraph`, which is byte-identical to `encode`; the `tests/tiny.bin` fixture checks this.
