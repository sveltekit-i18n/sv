// Runs the benchmark: `npm run bench` measures this tree, and
// `npm run bench -- --compare <dir>` measures it against the package checked
// out and installed at `<dir>` (master, in CI), printing a table of both. Node
// runs this file as it is, so it imports nothing it would have to compile:
// Node's modules, `sv`, which makes the fixtures, and this directory's
// modules, which Node runs as they are too.
//
//   --compare <dir>   the package root to measure against
//   --samples <n>     processes per side for the time rows (default 11)
//   --report <file>   also writes the table, as Markdown, to <file>
//   --write           writes BENCH.md from this tree's rows
//
// It exits with 1 when a project of this tree failed, and with 2 when only the
// comparison failed: a row of the base is missing from this tree, or a project
// of the base failed. The `bench-accepted` label lets the second pass in CI.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { create } from 'sv';

import { CASES, makeFixtures, type CaseId } from './cases.ts';
import { change, flagOf, median, spreadOf, THRESHOLD, type Kind } from './compare.ts';
import type { Row } from './collect.ts';

type Subject = 'master' | 'head';
type Project = 'sizes' | 'import' | `add:${CaseId}`;
type Measured = { kind: Kind; unit: string; values: number[] };

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'bench/out');
const FIXTURES = join(OUT, 'fixtures');
const KINDS: Kind[] = ['size', 'time'];

const { values: args } = parseArgs({
  options: {
    compare: { type: 'string' },
    samples: { type: 'string', default: '11' },
    report: { type: 'string' },
    write: { type: 'boolean', default: false },
  },
});

const samples = Number(args.samples);
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { name: string; version: string };
const name = pkg.name.split('/').pop() ?? pkg.name;
const roots: Partial<Record<Subject, string>> = { head: ROOT, ...(args.compare ? { master: resolve(args.compare) } : {}) };
const subjects = Object.keys(roots) as Subject[];
const failed: Record<Subject, Set<Project>> = { master: new Set(), head: new Set() };
// A project a signal ended, its timeout's or a crash's, is not run again, so
// a hang costs one timeout; each is kept with the sample it ended in.
const hung: Record<Subject, Map<Project, number>> = { master: new Map(), head: new Map() };
const where = (project: Project, sample: number) => (project === 'sizes' ? '' : ` in sample ${sample + 1} of ${samples}, and no later sample runs it`);

/**
 * Builds a side with its own `npm run build`, on its own install: the bundle
 * inlines `@sveltejs/sv-utils` and this package's devDependencies, so a bump
 * of either is a change of what ships, and is measured. Returns whether it
 * built; a side that did not fails every project.
 */
const build = (subject: Subject) => spawnSync('npm', ['run', 'build'], { cwd: roots[subject], stdio: ['ignore', 'ignore', 'inherit'] }).status === 0;

const built = Object.fromEntries(subjects.map((subject) => [subject, build(subject)])) as Partial<Record<Subject, boolean>>;

rmSync(FIXTURES, { recursive: true, force: true });
makeFixtures(FIXTURES, create);

/** The version of a package a side's install holds, for the report. */
const version = (subject: Subject, dependency: string) => {
  try {
    return (JSON.parse(readFileSync(join(roots[subject]!, 'node_modules', dependency, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'none';
  }
};

/** Runs one project against one subject in a process of its own and reads back its rows. */
const run = (subject: Subject, project: Project, sample: number): Row[] => {
  const out = join(OUT, subject, `${project.replace(':', '-')}-${sample}.json`);
  const [file, id] = project.split(':');

  rmSync(out, { force: true });

  const { status, signal, error } = built[subject] && !hung[subject].has(project)
    ? spawnSync(process.execPath, [join(ROOT, 'bench', `${file}.ts`)], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      // A project takes a second or two; one that never exits fails, and with
      // each project of both sides timing out once, the report still posts
      // within the job's time.
      timeout: 120_000,
      env: { ...process.env, BENCH_ROOT: roots[subject], BENCH_OUT: out, BENCH_FIXTURES: FIXTURES, BENCH_CASE: id },
    })
    : { status: 1, signal: null, error: undefined };

  if (status !== 0) failed[subject].add(project);
  if (signal) {
    hung[subject].set(project, sample);
    console.error(`The ${project} project of ${subject} ended by ${signal}${error ? ` (${error.message})` : ''}${where(project, sample)}.`);
  }

  return status === 0 && existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) as Row[] : [];
};

const measured: Record<Subject, Map<string, Measured>> = { master: new Map(), head: new Map() };

const add = (subject: Subject, rows: Row[]) => rows.forEach(({ id, kind, unit, value }) => {
  const entry = measured[subject].get(id) ?? { kind, unit, values: [] };

  entry.values.push(value);
  measured[subject].set(id, entry);
});

// Sizes are the same on every run, so one run of each side does.
for (const subject of subjects) add(subject, run(subject, 'sizes', 0));

// Times alternate between the sides, each sample in a fresh process, so a
// drift of the machine lands on both.
for (let sample = 0; sample < samples; sample++) {
  const order = sample % 2 ? [...subjects].reverse() : subjects;

  for (const subject of order) {
    for (const project of ['import', ...Object.keys(CASES).map((id) => `add:${id}` as const)] as Project[]) add(subject, run(subject, project, sample));
  }
}

const format = (value: number, unit: string) => {
  if (unit === 'ms') return `${value.toLocaleString('en-US', { maximumSignificantDigits: 3 })} ${unit}`;

  return `${Math.round(value).toLocaleString('en-US')} ${unit}`;
};

const spread = ({ values, unit }: Measured) => (values.length > 1 ? spreadOf(values).map((bound) => format(bound, unit)).join(' to ') : '');

type Line = { id: string; kind: Kind; master?: Measured; head?: Measured; flag: string; delta: string };

const compare = (id: string): Line => {
  const master = measured.master.get(id);
  const head = measured.head.get(id);
  const kind = (head ?? master)!.kind;

  if (!head) return { id, kind, master, flag: 'missing', delta: '' };

  if (!master) return { id, kind, head, flag: args.compare ? 'new' : '', delta: '' };

  const [from, to] = [median(master.values), median(head.values)];
  const share = change(from, to);
  const delta = from === to ? '0' : `${to > from ? '+' : ''}${format(to - from, head.unit)}${Number.isFinite(share) ? ` (${to > from ? '+' : ''}${(100 * share).toFixed(1)}%)` : ''}`;

  return { id, kind, master, head, delta, flag: flagOf(kind, master.values, head.values) };
};

const ids = [...new Set([...measured.head.keys(), ...measured.master.keys()])];
const lines = KINDS.flatMap((kind) => ids.map(compare).filter((line) => line.kind === kind));

const missing = lines.filter(({ flag }) => flag === 'missing');
const review = lines.filter(({ flag }) => flag.endsWith('review'));

const cell = (text: string) => text.replaceAll('|', '\\|');
const value = (entry?: Measured) => (entry ? format(median(entry.values), entry.unit) : 'n/a');

const table = args.compare
  ? [
    '| Row | Kind | Master | Head | Delta | Spread (master; head) | Flag |',
    '| --- | --- | ---: | ---: | ---: | --- | --- |',
    ...lines.map((line) => `| ${cell(line.id)} | ${line.kind} | ${value(line.master)} | ${value(line.head)} | ${line.delta} | ${line.kind === 'time' ? [line.master, line.head].map((entry) => (entry ? spread(entry) : 'n/a')).join('; ') : ''} | ${line.flag} |`),
  ]
  : [
    '| Row | Kind | Value | Spread |',
    '| --- | --- | ---: | --- |',
    ...lines.map((line) => `| ${cell(line.id)} | ${line.kind} | ${value(line.head)} | ${line.head ? spread(line.head) : ''} |`),
  ];

const compared = failed.master.size + missing.length;

const verdict = [
  ...[...failed.head].map((project) => `- **Failed:** the ${project} project of this branch. The job fails.`),
  ...[...failed.master].map((project) => `- **Failed on the base:** the ${project} project; its rows hold only the samples it completed, and a row it did not measure reads n/a.`),
  ...subjects.flatMap((subject) => [...hung[subject]].map(([project, sample]) => `- **Ended by a signal${subject === 'master' ? ' on the base' : ''}:** the ${project} project${where(project, sample)}.`)),
  ...missing.map(({ id }) => `- **Missing on head:** ${id}.`),
  compared && !failed.head.size ? '- The job fails on the comparison unless the PR carries the `bench-accepted` label.' : '',
  review.length ? `- ${review.length} row${review.length === 1 ? '' : 's'} to review: a size that grew, or a time beyond its spread by ${100 * THRESHOLD}% or more. None of them fails the job.` : '',
].filter(Boolean);

const installs = subjects.map((subject) => `${['sv', '@sveltejs/sv-utils'].map((dependency) => `\`${dependency}\` ${version(subject, dependency)}`).join(' and ')}${args.compare ? ` on ${subject === 'head' ? 'this branch' : 'the base'}` : ''}`).join('; ');

const environment = `Node ${process.version}, ${platform()} ${arch()}; ${installs}. A time is the first call in a process of its own, as \`sv\` makes it, and the median of ${samples} process${samples === 1 ? '' : 'es'}${args.compare ? ' per side' : ''}; a spread leaves out the lowest and the highest quarter of them, rounded down.`;

const report = [
  `<!-- bench:${name} -->`,
  `## Benchmark: \`${pkg.name}\``,
  '',
  args.compare ? 'This branch against its base.' : 'This tree.',
  environment,
  '',
  ...(verdict.length ? [...verdict, ''] : args.compare ? [`No size grew, and no time rose beyond its spread by ${100 * THRESHOLD}% or more.`, ''] : []),
  ...table,
  '',
].join('\n');

console.log(`\n${report}`);

if (args.report) writeFileSync(resolve(args.report), report);

if (args.write) {
  const section = (kind: Kind, title: string, blurb: string) => {
    const rows = lines.filter((line) => line.kind === kind && line.head);

    return [
      `## ${title}`,
      '',
      blurb,
      '',
      ...(kind === 'time' ? ['| Row | Median | Spread |', '| --- | ---: | --- |'] : ['| Row | Value |', '| --- | ---: |']),
      ...rows.map((line) => `| ${cell(line.id)} | ${value(line.head)} |${kind === 'time' ? ` ${spread(line.head!)} |` : ''}`),
      '',
    ];
  };

  writeFileSync(join(ROOT, 'BENCH.md'), [
    '# Benchmark',
    '',
    `What \`npm run bench\` measured on \`${pkg.name}\` ${pkg.version}, written by the release that published it. A pull request compares its branch with its base in a comment; this file keeps the figures of each release beside its code.`,
    '',
    environment,
    '',
    ...section('size', 'Sizes', 'Bytes of the bundle `sv` imports and of the tarball it downloads: the same on every machine.'),
    ...section('time', 'Times', 'Milliseconds, of one machine at one time: compare them only with figures measured beside them.'),
  ].join('\n'));
}

if (failed.head.size) process.exitCode = 1;
else if (compared) process.exitCode = 2;
