import { parseAllDocuments } from 'yaml';

export type DepNode = {
  name: string;
  version: string;
  pv: string;
  root: boolean;
  direct: boolean;
  dev: boolean;
  optional: boolean;
  installScript: boolean;
  depth: number;
  pathCount: number;
};
export type DepGraph = { nodes: DepNode[]; edges: [number, number][] };

const MAX_U32 = 0xffffffff;

export function parseLockfile(lockText: string): DepGraph {
  return lockText.trimStart().startsWith('{') ? parseNpmLock(lockText) : parsePnpmLock(lockText);
}

// package-lock.json v2/v3: the "packages" map keyed by install path (node_modules/a/node_modules/b)
function parseNpmLock(lockText: string): DepGraph {
  const lock = JSON.parse(lockText);
  const pkgs: Record<string, any> = lock.packages;
  if (!pkgs) throw new Error('unsupported lockfile: needs lockfileVersion 2 or 3');
  const rootEntry = pkgs[''] ?? {};
  const nodes: DepNode[] = [];
  const index = new Map<string, number>();
  const keyToNode = new Map<string, number>();

  const addNode = (name: string, version: string, entry: any, root = false) => {
    const pv = `${name}@${version}`;
    let i = index.get(pv);
    if (i === undefined) {
      i = nodes.length;
      index.set(pv, i);
      nodes.push({ name, version, pv, root, direct: false, dev: !!entry.dev, optional: !!entry.optional, installScript: !!entry.hasInstallScript, depth: 255, pathCount: 0 });
    } else {
      // a package is dev/optional only if every install of it is
      nodes[i].dev &&= !!entry.dev;
      nodes[i].optional &&= !!entry.optional;
      nodes[i].installScript ||= !!entry.hasInstallScript;
    }
    return i;
  };

  keyToNode.set('', addNode(rootEntry.name ?? lock.name ?? 'app', rootEntry.version ?? lock.version ?? '0.0.0', {}, true));
  for (const [key, entry] of Object.entries(pkgs)) {
    if (key === '' || entry.link || !entry.version) continue;
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    keyToNode.set(key, addNode(name, entry.version, entry));
  }

  const resolve = (fromKey: string, dep: string): number | undefined => {
    let base = fromKey;
    for (;;) {
      const hit = keyToNode.get(base ? `${base}/node_modules/${dep}` : `node_modules/${dep}`);
      if (hit !== undefined) return hit;
      if (!base) return undefined;
      const cut = base.lastIndexOf('/node_modules/');
      base = cut === -1 ? '' : base.slice(0, cut);
    }
  };

  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const [key, entry] of Object.entries(pkgs)) {
    const from = keyToNode.get(key);
    if (from === undefined) continue;
    const deps = { ...entry.peerDependencies, ...entry.optionalDependencies, ...entry.dependencies, ...(key === '' ? entry.devDependencies : {}) };
    for (const dep of Object.keys(deps)) {
      const to = resolve(key, dep);
      if (to === undefined || to === from) continue;
      const k = `${from}>${to}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push([from, to]);
      if (key === '') nodes[to].direct = true;
    }
  }
  computeDepthAndPaths(nodes, edges);
  return { nodes, edges };
}

// pnpm-lock.yaml v6-v9: "snapshots" (or "packages") keyed by name@version(peers); every workspace importer feeds the root
function parsePnpmLock(lockText: string): DepGraph {
  // pnpm 11 writes a first document that pins pnpm itself (with its own importers and packages); the lockfile proper is the last one
  const lock = parseAllDocuments(lockText).map((d: any) => d.toJS({ maxAliasCount: -1 })).filter((d) => d?.importers || d?.packages).at(-1) ?? {};
  const snaps: Record<string, any> = lock.snapshots ?? lock.packages ?? {};
  const meta: Record<string, any> = lock.packages ?? {};
  const nodes: DepNode[] = [];
  const index = new Map<string, number>();
  const strip = (v: string) => v.replace(/\(.*$/, '');
  const split = (key: string) => {
    const k = strip(key.replace(/^\//, ''));
    const at = k.lastIndexOf('@');
    return [k.slice(0, at), k.slice(at + 1)];
  };
  const node = (name: string, version: string) => {
    const pv = `${name}@${version}`;
    let i = index.get(pv);
    if (i === undefined) {
      i = nodes.length;
      index.set(pv, i);
      const m = meta[pv] ?? {};
      nodes.push({ name, version, pv, root: false, direct: false, dev: true, optional: true, installScript: !!m.requiresBuild, depth: 255, pathCount: 0 });
    }
    return i;
  };
  // "1.2.3(peer@1)" or an npm alias "real-name@1.2.3"
  const target = (dep: string, ref: string): [string, string] | null => {
    if (typeof ref !== 'string' || ref.startsWith('link:') || ref.startsWith('file:')) return null;
    const v = strip(ref);
    const at = v.lastIndexOf('@');
    return at > 0 ? [v.slice(0, at), v.slice(at + 1)] : [dep, v];
  };
  nodes.push({ name: 'workspace', version: '0.0.0', pv: 'workspace@0.0.0', root: true, direct: false, dev: false, optional: false, installScript: false, depth: 255, pathCount: 0 });
  index.set('workspace@0.0.0', 0);
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  const edge = (a: number, b: number) => {
    const k = `${a}>${b}`;
    if (a !== b && !seen.has(k)) { seen.add(k); edges.push([a, b]); }
  };
  for (const imp of Object.values<any>(lock.importers ?? { '.': lock })) {
    for (const [field, dev, optional] of [['dependencies', false, false], ['optionalDependencies', false, true], ['devDependencies', true, false]] as const) {
      for (const [dep, spec] of Object.entries<any>(imp[field] ?? {})) {
        const t = target(dep, typeof spec === 'string' ? spec : spec.version);
        if (!t) continue;
        const i = node(t[0], t[1]);
        nodes[i].direct = true;
        nodes[i].dev &&= dev;
        nodes[i].optional &&= optional;
        edge(0, i);
      }
    }
  }
  for (const [key, entry] of Object.entries<any>(snaps)) {
    const [name, version] = split(key);
    const from = node(name, version);
    for (const field of ['dependencies', 'optionalDependencies'] as const) {
      for (const [dep, ref] of Object.entries<any>(entry?.[field] ?? {})) {
        const t = target(dep, ref);
        if (t) edge(from, node(t[0], t[1]));
      }
    }
  }
  // dev/optional flow down from the importers: a package is dev-only if nothing non-dev reaches it
  const out: number[][] = nodes.map(() => []);
  for (const [a, b] of edges) out[a].push(b);
  for (const [flag] of [['dev'], ['optional']] as const) {
    const prod = new Set<number>();
    const stack = nodes.map((n, i) => (n.direct && !n[flag] ? i : -1)).filter((i) => i >= 0);
    stack.forEach((i) => prod.add(i));
    while (stack.length) for (const b of out[stack.pop()!]) if (!prod.has(b)) { prod.add(b); stack.push(b); }
    nodes.forEach((n, i) => { if (!n.root) n[flag] = !prod.has(i); });
  }
  computeDepthAndPaths(nodes, edges);
  return { nodes, edges };
}

// pathCount counts shortest root→node paths (the BFS DAG), which stays well-defined when npm graphs have cycles
function computeDepthAndPaths(nodes: DepNode[], edges: [number, number][]) {
  const out: number[][] = nodes.map(() => []);
  for (const [a, b] of edges) out[a].push(b);
  nodes[0].depth = 0;
  nodes[0].pathCount = 1;
  const order = [0];
  for (let h = 0; h < order.length; h++) {
    const a = order[h];
    for (const b of out[a]) {
      if (nodes[b].depth === 255) {
        nodes[b].depth = Math.min(254, nodes[a].depth + 1);
        order.push(b);
      }
      if (nodes[b].depth === nodes[a].depth + 1) nodes[b].pathCount = Math.min(MAX_U32, nodes[b].pathCount + nodes[a].pathCount);
    }
  }
}

export function packageName(pv: string) {
  return pv.slice(0, pv.lastIndexOf('@'));
}
