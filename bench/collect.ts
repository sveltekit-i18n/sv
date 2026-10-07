import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Kind } from './compare.ts';

export type Row = { id: string; kind: Kind; unit: string; value: number };

// The package root measured, built by `run.ts`, where its rows go, and the
// fixtures `run.ts` made for both sides.
const { BENCH_ROOT, BENCH_OUT, BENCH_FIXTURES } = process.env;

if (!BENCH_ROOT || !BENCH_OUT || !BENCH_FIXTURES) throw new Error('The benchmark runs through `npm run bench`.');

export const ROOT = BENCH_ROOT;
export const BUNDLE = join(BENCH_ROOT, 'dist/index.js');
export const FIXTURES = BENCH_FIXTURES;
export const OUT = BENCH_OUT;

const rows: Row[] = [];

// Written once the project has run to its end; a project that throws writes
// none, and `run.ts` reads it as failed.
process.on('exit', (code) => {
  if (code !== 0) return;

  mkdirSync(dirname(BENCH_OUT), { recursive: true });
  writeFileSync(BENCH_OUT, JSON.stringify(rows));
});

export const record = (id: string, kind: Kind, unit: string, value: number) => {
  rows.push({ id, kind, unit, value });
};
