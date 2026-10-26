import { describe, expect, it } from 'vitest';
import { applyEdits, editPackageJson } from '../src/connector/fixmr.ts';

const remedy = (over: object) => ({ name: 'zod', direct: true, action: { kind: 'upgrade', version: '4.6.6' }, ...over }) as any;
const pj = '{\n    "dependencies": {\n        "zod": "^3.24.2"\n    }\n}\n';

describe('fix merge request edits', () => {
  it('moves a direct dependency, keeping the indent and trailing newline', () => {
    expect(editPackageJson(pj, remedy({}), false)).toBe('{\n    "dependencies": {\n        "zod": "^4.6.6"\n    }\n}\n');
    expect(JSON.parse(editPackageJson(pj, remedy({ action: { kind: 'pin', version: '3.24.1' } }), false)).dependencies.zod).toBe('3.24.1');
  });

  it('forces a transitive version with npm overrides or pnpm.overrides', () => {
    const t = remedy({ name: 'ms', direct: false, action: { kind: 'upgrade', version: '2.1.3' } });
    expect(JSON.parse(editPackageJson(pj, t, false)).overrides).toEqual({ ms: '^2.1.3' });
    expect(JSON.parse(editPackageJson(pj, t, true)).pnpm.overrides).toEqual({ ms: '^2.1.3' });
  });

  it('replaces line ranges bottom-up and refuses code that changed since the scan', () => {
    const src = 'a\nb\nc\nd';
    expect(applyEdits(src, [{ startLine: 2, endLine: 2, before: 'b', after: 'B1\nB2' }, { startLine: 4, endLine: 4, before: 'd', after: 'D' }])).toBe('a\nB1\nB2\nc\nD');
    expect(() => applyEdits(src, [{ startLine: 1, endLine: 1, before: 'x', after: 'y' }])).toThrow(/changed since the scan/);
  });
});
