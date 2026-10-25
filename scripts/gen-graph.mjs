#!/usr/bin/env node
// Writes synthetic dependency graphs in the CONTRACT §1 binary format.
// node scripts/gen-graph.mjs --nodes 50000 --edges-per-node 2.4 --direct 40 --seed 1 --out web/public/demo/synthetic-50k.bin
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

export function encodeGraph({ names, depth, flags, pathCount, edgeFrom, edgeTo }) {
  const n = names.length;
  const e = edgeFrom.length;
  const nameBytes = new TextEncoder().encode(names.join('\n'));
  const arrays = (20 + 2 * n + 3) & ~3;
  const buf = new Uint8Array(arrays + 4 * (n + 2 * e) + nameBytes.length);
  const dv = new DataView(buf.buffer);
  buf.set(new TextEncoder().encode('DMAP'));
  dv.setUint16(4, 1, true);
  dv.setUint32(8, n, true);
  dv.setUint32(12, e, true);
  dv.setUint32(16, nameBytes.length, true);
  buf.set(depth, 20);
  buf.set(flags, 20 + n);
  let o = arrays;
  for (const arr of [pathCount, edgeFrom, edgeTo]) {
    for (const v of arr) {
      dv.setUint32(o, v, true);
      o += 4;
    }
  }
  buf.set(nameBytes, o);
  return buf;
}

const POPULAR = `lodash react react-dom express debug ms chalk commander semver uuid axios tslib glob minimatch yargs
  inherits safe-buffer readable-stream string_decoder util-deprecate core-util-is isarray process-nextick-args
  ansi-styles supports-color has-flag color-convert color-name escape-string-regexp strip-ansi ansi-regex
  wrap-ansi string-width emoji-regex is-fullwidth-code-point cliui y18n get-caller-file require-directory
  body-parser cookie cookie-signature accepts mime mime-types mime-db negotiator type-is media-typer
  content-type content-disposition depd destroy encodeurl escape-html etag finalhandler fresh http-errors
  merge-descriptors methods on-finished parseurl path-to-regexp proxy-addr qs range-parser raw-body send
  serve-static setprototypeof statuses toidentifier unpipe utils-merge vary iconv-lite safer-buffer bytes
  balanced-match brace-expansion concat-map fs.realpath inflight once wrappy path-is-absolute rimraf
  graceful-fs mkdirp minimist source-map source-map-support buffer-from js-tokens loose-envify scheduler
  picocolors nanoid postcss esbuild rollup vite typescript prettier eslint acorn ajv fast-deep-equal
  json-schema-traverse uri-js punycode fast-json-stable-stringify estraverse esutils esquery levn
  optionator prelude-ls type-check word-wrap deep-is fast-levenshtein argparse js-yaml lru-cache yallist
  which isexe cross-spawn path-key shebang-command shebang-regex signal-exit execa get-stream
  human-signals is-stream merge-stream npm-run-path onetime mimic-fn strip-final-newline micromatch
  braces fill-range to-regex-range is-number picomatch fast-glob glob-parent is-glob is-extglob
  chokidar anymatch normalize-path readdirp binary-extensions fsevents ws dotenv cors jsonwebtoken
  date-fns dayjs moment zod yup classnames clsx prop-types object-assign events buffer base64-js ieee754`
  .split(/\s+/);
const SCOPES = `@babel @types @aws-sdk @smithy @radix-ui @eslint @typescript-eslint @jest @sentry @opentelemetry
  @floating-ui @esbuild @rollup @vitest @octokit @nodelib @jridgewell @humanwhocodes @tanstack @emotion`.split(/\s+/);
const WORDS = `core utils parser plugin loader config cli runtime helpers types compat polyfill stream buffer path
  glob http client server cache queue color string array object promise async events logger format json yaml
  url query crypto hash middleware router schema validator transform resolve traverse generator template
  highlight code-frame compiler shared node web browser fetch retry signer credentials protocol`.split(/\s+/);

function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateGraph({ nodes, edgesPerNode, direct, seed, maxDepth, app = 'shop@1.0.0' }) {
  const rnd = mulberry32(seed);
  const int = (m) => Math.floor(rnd() * m);
  const pick = (a) => a[int(a.length)];
  // Fixed names and parents so the demo shows familiar packages: express > debug > ms, chalk direct.
  const fixed = { 1: 'express@4.21.2', 2: 'chalk@4.1.2', [direct + 1]: 'debug@4.3.4', [direct + 2]: 'ms@2.1.2' };
  const fixedParent = { [direct + 1]: 1, [direct + 2]: direct + 1 };
  const seen = new Set([app, ...Object.values(fixed)]);
  const freshName = () => {
    for (;;) {
      const r = rnd();
      const base =
        r < 0.5 ? pick(POPULAR)
        : r < 0.75 ? `${pick(SCOPES)}/${pick(WORDS)}${rnd() < 0.5 ? `-${pick(WORDS)}` : ''}`
        : `${pick(WORDS)}-${pick(WORDS)}`;
      const pv = `${base}@${Math.floor(rnd() ** 2 * 12)}.${int(20)}.${int(15)}`;
      if (!seen.has(pv)) {
        seen.add(pv);
        return pv;
      }
    }
  };

  const names = [app];
  const parent = [-1];
  const treeDepth = [0];
  const edges = [];
  const keys = new Set();
  const addEdge = (p, c) => {
    const k = p * nodes + c;
    if (keys.has(k)) return false;
    keys.add(k);
    edges.push([p, c]);
    return true;
  };
  for (let i = 1; i < nodes; i++) {
    names.push(fixed[i] ?? freshName());
    let p = 0;
    if (fixedParent[i] !== undefined) p = fixedParent[i];
    else if (i > direct) {
      p = 1 + int(i - 1);
      while (treeDepth[p] >= maxDepth || p === direct + 1 || p === direct + 2) p = parent[p];
    }
    parent.push(p);
    treeDepth.push(treeDepth[p] + 1);
    addEdge(p, i);
  }
  // Cross edges only target tree leaves, which stay sinks: the graph is acyclic and reachability stays
  // realistic. Squaring biases targets towards early, shallow leaves, which become widely shared like ms.
  const hasKids = new Uint8Array(nodes);
  for (const p of parent) if (p >= 0) hasKids[p] = 1;
  const leaves = [];
  const sources = [];
  for (let i = 1; i < nodes; i++) (hasKids[i] ? sources : leaves).push(i);
  const want = Math.round(nodes * edgesPerNode);
  for (let tries = 0; edges.length < want && tries < want * 10; tries++) {
    addEdge(pick(sources), leaves[Math.floor(rnd() ** 2 * leaves.length)]);
  }
  // Edges into non-leaves are tree edges from lower indices, so this order is topological.
  edges.sort((a, b) => (hasKids[b[1]] - hasKids[a[1]]) || a[1] - b[1] || a[0] - b[0]);

  const depth = new Uint8Array(nodes).fill(255);
  const pathCount = new Uint32Array(nodes);
  const flags = new Uint8Array(nodes);
  depth[0] = 0;
  pathCount[0] = 1;
  flags[0] = 128;
  for (const [p, c] of edges) {
    depth[c] = Math.min(depth[c], depth[p] + 1);
    pathCount[c] = Math.min(0xffffffff, pathCount[c] + pathCount[p]);
  }
  for (let i = 1; i < nodes; i++) {
    flags[i] = (depth[i] === 1 ? 1 : 0) | (rnd() < 0.1 ? 2 : 0) | (rnd() < 0.02 ? 4 : 0) | (rnd() < 0.01 ? 8 : 0);
  }
  return {
    names, depth, flags, pathCount,
    edgeFrom: Uint32Array.from(edges, (e) => e[0]),
    edgeTo: Uint32Array.from(edges, (e) => e[1]),
  };
}

if (import.meta.main) {
  const { values: v } = parseArgs({
    options: {
      nodes: { type: 'string', default: '300' },
      'edges-per-node': { type: 'string', default: '1.5' },
      direct: { type: 'string', default: '12' },
      'max-depth': { type: 'string', default: '12' },
      seed: { type: 'string', default: '1' },
      app: { type: 'string', default: 'shop@1.0.0' },
      out: { type: 'string' },
    },
  });
  if (!v.out) throw new Error('--out is required');
  const graph = generateGraph({
    nodes: +v.nodes, edgesPerNode: +v['edges-per-node'], direct: +v.direct,
    maxDepth: +v['max-depth'], seed: +v.seed, app: v.app,
  });
  const bytes = encodeGraph(graph);
  mkdirSync(dirname(v.out), { recursive: true });
  writeFileSync(v.out, bytes);
  const maxDepth = Math.max(...graph.depth.filter((d) => d !== 255));
  console.log(`${v.out}: ${graph.names.length} nodes, ${graph.edgeFrom.length} edges, max depth ${maxDepth}, ${bytes.length} bytes`);
}
