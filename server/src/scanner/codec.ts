import type { DepGraph } from './lockfile.ts';

export const FLAG = { direct: 1, dev: 2, installScript: 4, optional: 8, root: 128 } as const;
export const DYN = { vuln: 1, malicious: 2, deprecated: 4, decided: 8, changed: 16, recent: 32, fingerprint: 64 } as const;

// docs/CONTRACT.md §1
export function encodeGraph(g: DepGraph): Buffer {
  const n = g.nodes.length;
  const e = g.edges.length;
  const names = Buffer.from(g.nodes.map((x) => x.pv).join('\n'), 'utf8');
  const head = 20 + 2 * n;
  const pad = (4 - (head % 4)) % 4;
  const buf = Buffer.alloc(head + pad + 4 * n + 8 * e + names.length);
  buf.write('DMAP', 0, 'ascii');
  buf.writeUInt16LE(1, 4);
  buf.writeUInt32LE(n, 8);
  buf.writeUInt32LE(e, 12);
  buf.writeUInt32LE(names.length, 16);
  g.nodes.forEach((x, i) => {
    buf[20 + i] = x.depth;
    buf[20 + n + i] = (x.direct ? FLAG.direct : 0) | (x.dev ? FLAG.dev : 0) | (x.installScript ? FLAG.installScript : 0) | (x.optional ? FLAG.optional : 0) | (x.root ? FLAG.root : 0);
  });
  let o = head + pad;
  for (const x of g.nodes) { buf.writeUInt32LE(x.pathCount, o); o += 4; }
  for (const [a] of g.edges) { buf.writeUInt32LE(a, o); o += 4; }
  for (const [, b] of g.edges) { buf.writeUInt32LE(b, o); o += 4; }
  names.copy(buf, o);
  return buf;
}
