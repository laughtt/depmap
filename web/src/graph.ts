import init, { Graph } from "./wasm/graph_core.js";

export const LAYOUT_VERSION = 1;
export const RADIUS = 1000;
export const TREE_W = 2000, TREE_H = 1500;
export const F = { direct: 1, dev: 2, install: 4, optional: 8, root: 128 } as const;

export type Bin = { n: number; e: number; depth: Uint8Array; flags: Uint8Array; pathCount: Uint32Array; edgeFrom: Uint32Array; edgeTo: Uint32Array; names: string[] };

export function parseBin(bytes: Uint8Array): Bin {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "DMAP") throw new Error("Not a depmap graph file");
  const n = dv.getUint32(8, true), e = dv.getUint32(12, true), namesLen = dv.getUint32(16, true);
  const depth = bytes.slice(20, 20 + n), flags = bytes.slice(20 + n, 20 + 2 * n);
  const pc = (20 + 2 * n + 3) & ~3;
  const pathCount = new Uint32Array(bytes.slice(pc, pc + 4 * n).buffer);
  const ef = pc + 4 * n, namesAt = ef + 8 * e;
  const edgeFrom = new Uint32Array(bytes.slice(ef, ef + 4 * e).buffer), edgeTo = new Uint32Array(bytes.slice(ef + 4 * e, namesAt).buffer);
  const names = new TextDecoder().decode(bytes.subarray(namesAt, namesAt + namesLen)).split("\n");
  return { n, e, depth, flags, pathCount, edgeFrom, edgeTo, names };
}

export type Loaded = Bin & {
  g: Graph; pos: Float32Array; cacheHit: boolean; layoutMs: number; maxDepth: number; tree: boolean;
  primary: Uint32Array; byName: Map<string, number>;
};

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open("depmap", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("layouts");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function cache<T>(mode: "get" | "put", key: string, value?: T): Promise<T | undefined> {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const store = db.transaction("layouts", mode === "get" ? "readonly" : "readwrite").objectStore("layouts");
      const r = mode === "get" ? store.get(key) : store.put(value, key);
      r.onsuccess = () => res(mode === "get" ? r.result : undefined);
      r.onerror = () => rej(r.error);
    });
  } catch {
    return undefined;
  }
}

let ready: Promise<unknown> | null = null;

export async function loadGraph(bytes: Uint8Array, lockfileSha: string, tree = false): Promise<Loaded> {
  ready ??= Promise.all([init(), ...['500 11px "JetBrains Mono"', '500 11px "Instrument Sans"'].map((f) => document.fonts.load(f).catch(() => []))]);
  await ready;
  const bin = parseBin(bytes);
  const g = Graph.fromBytes(bytes);
  let maxDepth = 1;
  for (const d of bin.depth) if (d !== 255 && d > maxDepth) maxDepth = d;
  const key = `${lockfileSha}:${LAYOUT_VERSION}${tree ? ":tree" : ""}`;
  let pos = await cache<Float32Array>("get", key);
  const cacheHit = !!pos && pos.length === bin.n * 2;
  let layoutMs = 0;
  if (!cacheHit) {
    const t = performance.now();
    pos = tree ? g.layoutTree(TREE_W, TREE_H / (maxDepth + 1)) : g.layout(RADIUS);
    layoutMs = Math.round(performance.now() - t);
    console.info(`[depmap] layout ${bin.n} nodes in ${layoutMs} ms`);
    await cache("put", key, pos);
  } else console.info(`[depmap] layout cache hit for ${bin.n} nodes`);
  const byName = new Map<string, number>();
  bin.names.forEach((s, i) => byName.set(s, i));
  const w = g as Graph & { flags?: () => Uint8Array; pathCounts?: () => Uint32Array };
  return {
    ...bin, g, pos: pos!, cacheHit, layoutMs, maxDepth, byName, tree,
    flags: w.flags?.() ?? bin.flags, pathCount: w.pathCounts?.() ?? bin.pathCount,
    edgeFrom: g.edgeFrom(), edgeTo: g.edgeTo(), primary: g.primaryParents(),
  };
}

export function chains(G: Loaded, node: number, limit = 5): number[][] {
  const parents = new Map<number, number[]>();
  for (const e of G.g.pathsToRoot(node)) {
    const c = G.edgeTo[e];
    if (!parents.has(c)) parents.set(c, []);
    parents.get(c)!.push(G.edgeFrom[e]);
  }
  for (const [c, ps] of parents) ps.sort((a, b) => (a === G.primary[c] ? -1 : b === G.primary[c] ? 1 : G.depth[a] - G.depth[b]));
  const out: number[][] = [];
  const walk = (n: number, path: number[]) => {
    if (out.length >= limit) return;
    if (n === 0) return void out.push([0, ...path]);
    for (const p of parents.get(n) ?? []) if (!path.includes(p)) walk(p, [n, ...path]);
  };
  walk(node, []);
  return out;
}

export const pvName = (pv: string) => pv.slice(0, pv.lastIndexOf("@") > 0 ? pv.lastIndexOf("@") : pv.length);
export const pvVersion = (pv: string) => (pv.lastIndexOf("@") > 0 ? pv.slice(pv.lastIndexOf("@") + 1) : "");
