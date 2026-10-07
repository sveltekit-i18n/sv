// The bytes of the add-on: the bundle `sv` imports, and the tarball `sv`
// downloads to import it from.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { BUNDLE, record, ROOT } from './collect.ts';

record('dist/index.js, minified', 'size', 'B', readFileSync(BUNDLE).byteLength);

// npm 10 runs the side's `prepare`, which installs its git hooks, even with
// `--ignore-scripts`; what that prints is left out of the run's output.
const packed = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
// npm 10 and 11 print a list, npm 12 an object keyed by the package's name.
const pack = JSON.parse(packed) as { size: number }[] | Record<string, { size: number }>;
const [{ size }] = Array.isArray(pack) ? pack : Object.values(pack);

record('the tarball sv downloads, gzipped', 'size', 'B', size);
