import pg from 'pg';
import { readFile } from 'node:fs/promises';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://depmap:depmap@localhost:5433/depmap', max: 10 });

export async function migrate() {
  await pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
}

export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(text, params)).rows;
}
