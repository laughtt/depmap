import { parseSync } from 'oxc-parser';

export type Usage = {
  file: string;
  line: number;
  code: string;
  kind: 'require' | 'import' | 'dynamic';
  style: 'default' | 'namespace' | 'named' | 'binding';
  binding?: string;
  symbols: { name: string; line: number; code: string }[];
};

const matches = (spec: unknown, pkg: string) => typeof spec === 'string' && (spec === pkg || spec.startsWith(`${pkg}/`));

function walk(node: any, parent: any, visit: (n: any, p: any) => void) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, node, visit);
    else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v, node, visit);
  }
}

export function findUsage(sources: { path: string; content: string }[], pkg: string): Usage[] {
  const out: Usage[] = [];
  for (const src of sources) {
    if (!src.content.includes(pkg)) continue;
    let program: any;
    try {
      program = parseSync(src.path, src.content).program;
    } catch {
      continue;
    }
    const lineStarts = [0];
    for (let i = 0; i < src.content.length; i++) if (src.content[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (offset: number) => {
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
      return lo + 1;
    };
    const lines = src.content.split('\n');
    const codeAt = (line: number) => lines[line - 1]?.trim() ?? '';
    const sites: Usage[] = [];

    walk(program, null, (n, p) => {
      if (n.type === 'ImportDeclaration' && matches(n.source.value, pkg)) {
        const line = lineOf(n.start);
        for (const s of n.specifiers ?? []) {
          const style = s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? 'namespace' : 'named';
          sites.push({ file: src.path, line, code: codeAt(line), kind: 'import', style, binding: s.local.name,
            symbols: style === 'named' ? [{ name: s.imported.name ?? s.imported.value, line, code: codeAt(line) }] : [] });
        }
        if (!n.specifiers?.length) sites.push({ file: src.path, line, code: codeAt(line), kind: 'import', style: 'named', symbols: [] });
      }
      if (n.type === 'ImportExpression' && matches(n.source?.value, pkg)) {
        const line = lineOf(n.start);
        sites.push({ file: src.path, line, code: codeAt(line), kind: 'dynamic', style: 'namespace', symbols: [] });
      }
      if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require' && matches(n.arguments[0]?.value, pkg)) {
        const line = lineOf(n.start);
        const site: Usage = { file: src.path, line, code: codeAt(line), kind: 'require', style: 'binding', symbols: [] };
        if (p?.type === 'VariableDeclarator' && p.id.type === 'Identifier') site.binding = p.id.name;
        else if (p?.type === 'VariableDeclarator' && p.id.type === 'ObjectPattern') {
          site.style = 'named';
          site.symbols = p.id.properties.filter((x: any) => x.key?.name).map((x: any) => ({ name: x.key.name, line, code: codeAt(line) }));
        } else if (p?.type === 'CallExpression' && p.callee === n) site.symbols = [{ name: '()', line, code: codeAt(line) }];
        else if (p?.type === 'MemberExpression' && p.object === n && !p.computed) site.symbols = [{ name: p.property.name, line, code: codeAt(line) }];
        sites.push(site);
      }
    });

    // member accesses and calls on each binding: chalk.red(...), debug('x')
    walk(program, null, (n, p) => {
      for (const site of sites) {
        if (!site.binding) continue;
        if (n.type === 'MemberExpression' && !n.computed && n.object.type === 'Identifier' && n.object.name === site.binding) {
          const line = lineOf(n.start);
          if (!site.symbols.some((s) => s.name === n.property.name && s.line === line)) site.symbols.push({ name: n.property.name, line, code: codeAt(line) });
        }
        if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === site.binding) {
          const line = lineOf(n.start);
          site.symbols.push({ name: '()', line, code: codeAt(line) });
        }
      }
    });
    out.push(...sites);
  }
  return out;
}
