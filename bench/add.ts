// The add-on's `run()` on one case, timed on its first call, the one `sv`
// makes: `sv` runs an add-on once per process. `add()`, the `sv` API the
// call goes through, comes from the `sv` the side's bundle resolves, and its
// own work around `run()` is left out of the row.
import { cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { add as Add } from 'sv';

import { CASES, unwritten, type CaseId } from './cases.ts';
import { BUNDLE, FIXTURES, OUT, record } from './collect.ts';

const id = process.env.BENCH_CASE as CaseId;
const subject = CASES[id];
const cwd = OUT.replace(/\.json$/, '');

const { add } = await import(pathToFileURL(createRequire(BUNDLE).resolve('sv')).href) as { add: typeof Add };
const { default: addon } = await import(pathToFileURL(BUNDLE).href) as typeof import('../src/index.ts');

rmSync(cwd, { recursive: true, force: true });
cpSync(join(FIXTURES, id), cwd, { recursive: true });

let duration = 0;

const timed: typeof addon = {
  ...addon,
  run: async (workspace) => {
    const start = performance.now();

    await addon.run(workspace);
    duration = performance.now() - start;
  },
};

const { status } = await add({ cwd, addons: { [addon.id]: timed }, options: { [addon.id]: subject.options } });

if (status[addon.id] !== 'success') throw new Error(`The add-on did not run on ${id}: ${JSON.stringify(status[addon.id])}`);
const left = unwritten(cwd, join(FIXTURES, id), subject.wrote);

if (left.length) throw new Error(`The add-on ran on ${id} and left ${left.join(', ')} alone.`);

rmSync(cwd, { recursive: true, force: true });

record(subject.row, 'time', 'ms', duration);
