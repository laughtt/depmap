import { readFileSync } from 'node:fs';

export const CATEGORIES = ['http', 'auth-crypto', 'data', 'build', 'lint', 'test', 'types', 'ui', 'cli', 'fs-process', 'database', 'sdk', 'polyfill', 'utility'] as const;

// obvious families by name; everything else comes from categories.json, written once by a Haiku agent
const RULES: [RegExp, (typeof CATEGORIES)[number]][] = [
  [/^@types\//, 'types'],
  [/eslint|prettier|^@typescript-eslint\//, 'lint'],
  [/^(jest|vitest|mocha|chai|sinon|playwright|@playwright\/|@testing-library\/|supertest|nock)/, 'test'],
  [/^(@babel\/|babel-|webpack|rollup|@rollup\/|esbuild|@esbuild\/|vite|@vitejs\/|postcss|autoprefixer|tailwindcss|@tailwindcss\/|typescript$|tsx$|ts-node|@swc\/|terser|sass|less$|@next\/swc|lightningcss)/, 'build'],
  [/^(react|react-dom|@radix-ui\/|@floating-ui\/|@emotion\/|styled-components|framer-motion|lucide|@headlessui\/|clsx$|class-variance-authority|tailwind-merge)/, 'ui'],
  [/^(es-|has-|is-|get-intrinsic|call-bind|call-bound|define-|object\.|array\.|string\.|function\.|typed-array|available-typed|gopd$|hasown$|side-channel|which-|safe-|set-function|reflect\.|globalthis|internal-slot|dunder-proto|math-intrinsics)/, 'polyfill'],
  [/^(pg|mysql|sqlite|better-sqlite3|drizzle|prisma|@prisma\/|mongoose|mongodb|redis|ioredis|knex|kysely|typeorm|sequelize)/, 'database'],
  [/^(@aws-sdk\/|@smithy\/|@google-cloud\/|@azure\/|stripe$|@stripe\/|@clerk\/|@anthropic-ai\/|openai$|@supabase\/|firebase)/, 'sdk'],
  [/^(jsonwebtoken|jose$|bcrypt|crypto-|node-forge|passport|oauth|@noble\/|tweetnacl|uuid$)/, 'auth-crypto'],
];

let known: Record<string, string> = {};
try {
  known = JSON.parse(readFileSync(new URL('./categories.json', import.meta.url), 'utf8'));
} catch {}

export function categoryOf(name: string): string {
  return known[name] ?? RULES.find(([re]) => re.test(name))?.[1] ?? 'unclassified';
}
