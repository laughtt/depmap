import { gunzipSync } from 'node:zlib';
import { posix } from 'node:path';
import ts from 'typescript';
import { q } from '../db/db.ts';
import { cachedDerived } from '../scanner/http.ts';

export type Knowledge = {
  pv: string;
  moduleFormat: 'esm-only' | 'cjs' | 'dual';
  exportStyle: 'default' | 'export=' | 'named' | 'unknown';
  named: Record<string, string>;
  members: Record<string, string>;
  hasTypes: boolean;
  engines?: string;
  changelog?: string;
  tarball: string;
};

// tar is 512-byte headers followed by file data padded to 512; only the files we need are kept
function untar(buf: Buffer, keep: (path: string) => boolean): Map<string, string> {
  const files = new Map<string, string>();
  for (let o = 0; o + 512 <= buf.length;) {
    const name = buf.toString('utf8', o, o + 100).replace(/\0.*$/s, '');
    if (!name) break;
    const prefix = buf.toString('utf8', o + 345, o + 500).replace(/\0.*$/s, '');
    const size = parseInt(buf.toString('ascii', o + 124, o + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = buf[o + 156];
    const path = (prefix ? `${prefix}/${name}` : name).replace(/^[^/]+\//, '');
    if ((type === 0 || type === 48) && keep(path)) files.set(path, buf.toString('utf8', o + 512, o + 512 + size));
    o += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function moduleFormat(pkg: any): Knowledge['moduleFormat'] {
  const conds = JSON.stringify(pkg.exports ?? {});
  const hasRequire = conds.includes('"require"') || conds.includes('"node"') && pkg.type !== 'module' || /\.cjs"/.test(conds);
  if (pkg.type === 'module') return hasRequire ? 'dual' : 'esm-only';
  return conds.includes('"import"') ? 'dual' : 'cjs';
}

function typesEntry(pkg: any, files: Map<string, string>): string | undefined {
  const exp = pkg.exports?.['.'] ?? pkg.exports;
  const candidates = [pkg.types, pkg.typings, exp?.types, exp?.import?.types, exp?.default?.types, exp?.require?.types, 'index.d.ts']
    .filter((x): x is string => typeof x === 'string')
    .map((x) => posix.normalize(x).replace(/^\.\//, ''))
    .flatMap((x) => (x.endsWith('.d.ts') ? [x] : [`${x}.d.ts`, `${x}/index.d.ts`, x.replace(/\.(m|c)?js$/, '.d.ts')]));
  return candidates.find((c) => files.has(c));
}

// exported API from the package's own .d.ts, resolved with the TypeScript compiler against the in-memory tarball
function apiSurface(files: Map<string, string>, entry: string) {
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost({}),
    getSourceFile: (f, lang) => (files.has(f) ? ts.createSourceFile(f, files.get(f)!, lang) : undefined),
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f),
    getCurrentDirectory: () => '',
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => {},
  };
  const program = ts.createProgram([entry], { noLib: true, types: [], skipLibCheck: true, noResolve: false }, host);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(entry);
  const moduleSym = sf && checker.getSymbolAtLocation(sf);
  const named: Record<string, string> = {};
  const members: Record<string, string> = {};
  if (!sf || !moduleSym) return { exportStyle: 'unknown' as const, named, members };
  const sig = (s: ts.Symbol) => checker.typeToString(checker.getTypeOfSymbolAtLocation(s, sf)).slice(0, 160);
  const memberList = (s: ts.Symbol) => {
    for (const p of checker.getPropertiesOfType(checker.getTypeOfSymbolAtLocation(s, sf))) members[p.name] = sig(p);
    if (checker.getTypeOfSymbolAtLocation(s, sf).getCallSignatures().length) members['()'] = sig(s);
  };
  const exportEquals = moduleSym.exports?.get(ts.InternalSymbolName.ExportEquals);
  if (exportEquals) {
    memberList(exportEquals);
    return { exportStyle: 'export=' as const, named, members };
  }
  for (const s of checker.getExportsOfModule(moduleSym)) named[s.name] = sig(s);
  const def = checker.getExportsOfModule(moduleSym).find((s) => s.name === 'default');
  if (def) memberList(def);
  return { exportStyle: def ? ('default' as const) : ('named' as const), named, members };
}

function changelogBetween(text: string | undefined, from: string, to: string) {
  if (!text) return undefined;
  const lines = text.split('\n');
  const head = (v: string) => lines.findIndex((l) => /^#{1,3}\s/.test(l) && l.includes(v));
  const start = head(to);
  if (start === -1) return undefined;
  const end = head(from);
  return lines.slice(start, end > start ? end : start + 40).join('\n').slice(0, 3000);
}

export async function knowledge(name: string, version: string, tarball: string | undefined): Promise<Knowledge | null> {
  const pv = `${name}@${version}`;
  const [row] = await q('select data from pv_api where pv = $1', [pv]);
  if (row) return row.data;
  if (!tarball) return null;
  const data: Knowledge | null = await cachedDerived(`knowledge ${pv} v1`, async () => {
    const res = await fetch(tarball);
    if (!res.ok) return null;
    const files = untar(gunzipSync(Buffer.from(await res.arrayBuffer())), (p) => p === 'package.json' || p.endsWith('.d.ts') || p.endsWith('.d.mts') || p.endsWith('.d.cts') || /^(changelog|history|changes)(\.md)?$/i.test(p));
    const pkg = JSON.parse(files.get('package.json') ?? '{}');
    const entry = typesEntry(pkg, files);
    const surface = entry ? apiSurface(files, entry) : { exportStyle: 'unknown' as const, named: {}, members: {} };
    const changelog = [...files.entries()].find(([p]) => /^(changelog|history|changes)/i.test(p))?.[1];
    return { pv, moduleFormat: moduleFormat(pkg), ...surface, hasTypes: !!entry, engines: pkg.engines?.node, changelog: changelog?.slice(0, 60_000), tarball };
  });
  if (data) await q('insert into pv_api (pv, data) values ($1,$2) on conflict (pv) do nothing', [pv, data]);
  return data;
}

export { changelogBetween };
