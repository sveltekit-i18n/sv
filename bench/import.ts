// The cold import of the add-on, once per process as `sv` imports it. `sv`
// is loaded first, as the CLI that imports the add-on has it loaded already,
// so the row reads the add-on's own load and not `sv`'s.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { BUNDLE, record } from './collect.ts';

await import(pathToFileURL(createRequire(BUNDLE).resolve('sv')).href);

const start = performance.now();

await import(pathToFileURL(BUNDLE).href);

record('import the add-on, sv loaded', 'time', 'ms', performance.now() - start);
