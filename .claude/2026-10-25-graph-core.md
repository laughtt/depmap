# graph-core (Rust -> WASM) and gen-graph.mjs

## Changes
- `crates/graph-core`: decoder/encoder for the CONTRACT §1 binary, `Graph` with the §3 API, free fns `diff`/`removed`.
- `scripts/gen-graph.mjs`: seeded synthetic graph generator + exported `encodeGraph` (byte-identical to Rust `encode`).
- Generated: `web/src/wasm/`, `server/wasm/` (wasm-pack), `web/public/demo/{small,synthetic-50k}.bin`.

## Flow
bytes -> decode (validate magic/version/lengths/edge bounds) -> CSR out/in adjacency (edge indices).
layout: primary parents (min depth, tie by name) -> children CSR sorted by name -> BFS order ->
subtree sizes (reverse order) -> spans proportional to size -> polar placement with sibling jitter ->
nodes outside the tree on the outer ring.

## Decisions
- Names kept in one String + offsets; no per-node Strings.
- Primary parent requires depth[p] < depth[c], guaranteeing a tree even on inconsistent input.
- `decode` returns `Result<_, String>` so native tests never touch JS; `fromBytes` maps it to JsError.
- JS/Rust encoder parity checked through a committed fixture `tests/tiny.bin` written by the JS encoder.
