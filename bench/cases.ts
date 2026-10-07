// The projects `run()` is timed on, which `run.ts` makes once per run, with
// this tree's `sv`, so both sides run on the same bytes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Routing } from '../src/options.ts';
import type { ExtensionId, FormatId } from '../src/packages.ts';

/** The options as the command line hands them on, every one stated. */
type Options = { locales: string; format: FormatId; routing: Routing; typegen: boolean; extensions: ExtensionId[]; demo: boolean };

export type Case = {
  row: string;
  types: 'typescript' | 'checkjs';
  options: Options;
  /** What the project holds beyond `sv create`'s minimal template. */
  files?: Record<string, string>;
  /** Every file the run writes, so a side that leaves one alone, as a transform that fails soft does, cannot read as fast. */
  wrote: string[];
};

const DEFAULTS: Options = { locales: 'en', format: 'curly', routing: 'cookie', typegen: true, extensions: [], demo: true };

const EVERY: Options = { locales: 'en,cs,ar', format: 'icu', routing: 'prefix', typegen: true, extensions: ['typed-access', 'html', 'stores'], demo: true };

/** What a run with typegen and the demo writes besides the hooks and the layout loads, the demo page under `demo`. */
const common = (language: 'ts' | 'js', demo: string) => [
  '.gitignore',
  'package.json',
  'src/app.html',
  `vite.config.${language}`,
  `src/lib/i18n.${language}`,
  'src/lib/translations/en/common.json',
  'src/routes/+layout.svelte',
  'src/routes/demo/DemoLinks.svelte',
  `src/routes${demo}/demo/sveltekit-i18n/+page.svelte`,
];

/** The hooks and both layout loads. */
const loads = (language: 'ts' | 'js') => [`src/hooks.server.${language}`, `src/routes/+layout.server.${language}`, `src/routes/+layout.${language}`];

/** `routing: prefix`'s helpers and matcher. */
const prefixed = (language: 'ts' | 'js') => [`src/lib/locale.${language}`, `src/params.${language}`];

/**
 * A file two transforms write, and what the add-on's own one writes there:
 * `rootLayout` leaves a layout it parses alone in several shapes, while the
 * demo puts its links in the file either way.
 */
const SHARED: Record<string, string> = { 'src/routes/+layout.svelte': 'use(' };

/**
 * The files of `wrote` the run left alone: missing, as `fixture` holds them,
 * or, in `SHARED`, without their piece. Only `SHARED` names text the add-on
 * writes, which both sides then have to write; every other file is judged by
 * whether it changed.
 */
export const unwritten = (cwd: string, fixture: string, wrote: string[]) => wrote.filter((file) => {
  const read = (root: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : undefined);
  const after = read(cwd);

  return after === undefined || after === read(fixture) || (file in SHARED && !after.includes(SHARED[file]));
});

/** `count` functions of six lines each, a module's own code the merge reads past. */
const helpers = (count: number) => Array.from({ length: count }, (_, i) => `/** Helper ${i}. */
export function helper${i}(value: number): number {
\t// Kept apart from the others.
\treturn value + ${i};
}
`).join('\n');

/** A project with its own `handle`, both layout loads, a layout typed by its own props and `params`, each script after `prelude`. */
const own = (prelude: string): Record<string, string> => ({
  'src/hooks.server.ts': `import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit/hooks';
${prelude}
const headers: Handle = async ({ event, resolve }) => {
\tconst response = await resolve(event);
\tresponse.headers.set('x-app', 'own');
\treturn response;
};

const timing: Handle = async ({ event, resolve }) => resolve(event);

export const handle = sequence(headers, timing);
`,
  'src/routes/+layout.server.ts': `import type { LayoutServerLoad } from './$types';
${prelude}
export const load: LayoutServerLoad = async () => ({ user: 'Ada' });
`,
  'src/routes/+layout.ts': `import type { LayoutLoad } from './$types';
${prelude}
export const load: LayoutLoad = async ({ data }) => ({ ...data, theme: 'dark' });
`,
  'src/routes/+layout.svelte': `<script lang="ts">
\timport type { Snippet } from 'svelte';

\tlet { children }: { children: Snippet } = $props();
</script>

{@render children()}
`,
  'src/params.ts': `import { defineParams } from '@sveltejs/kit/params';
${prelude}
export const params = defineParams({
\tslug: (param) => (/^[a-z-]+$/.test(param) ? param : undefined),
});
`,
});

export const CASES = {
  ts: {
    row: 'run(), TypeScript, default options',
    types: 'typescript',
    options: DEFAULTS,
    wrote: [...common('ts', ''), ...loads('ts')],
  },
  js: {
    row: 'run(), JavaScript, every option',
    types: 'checkjs',
    options: EVERY,
    wrote: [
      ...common('js', '/[[lang=locale]]'),
      ...loads('js'),
      ...prefixed('js'),
      'src/lib/translations/cs/common.json',
      'src/lib/translations/ar/common.json',
    ],
  },
  merge: {
    row: 'run(), a project with its own hooks, layout loads and params',
    types: 'typescript',
    options: { ...DEFAULTS, routing: 'prefix' },
    files: own(''),
    wrote: [...common('ts', '/[[lang=locale]]'), ...loads('ts'), ...prefixed('ts')],
  },
  // About 2,000 lines in the hooks, both layout loads and `params`, where a
  // transform that grows faster than the file shows apart from the rest of
  // the run.
  large: {
    row: 'run(), the same with 2,000 lines in each of those',
    types: 'typescript',
    options: { ...DEFAULTS, routing: 'prefix' },
    files: own(`\n${helpers(333)}`),
    wrote: [...common('ts', '/[[lang=locale]]'), ...loads('ts'), ...prefixed('ts')],
  },
} satisfies Record<string, Case>;

export type CaseId = keyof typeof CASES;

/** Makes the project of each case under `fixtures`, with `create` from `sv`. */
export const makeFixtures = (fixtures: string, create: (options: { cwd: string; name: string; template: 'minimal'; types: Case['types'] }) => void) => {
  for (const [id, { types, files = {} }] of Object.entries(CASES) as [CaseId, Case][]) {
    const cwd = join(fixtures, id);

    create({ cwd, name: id, template: 'minimal', types });

    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, file)), { recursive: true });
      writeFileSync(join(cwd, file), content);
    }
  }
};
