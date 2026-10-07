import { expect as playwrightExpect } from '@playwright/test';
import { add } from 'sv';

import addon from '../../src/index.js';
import type { ExtensionId } from '../../src/packages.js';
import { read, script, serve, tree, write } from '../setup/project.js';
import { setupTest } from '../setup/suite.js';

const id = addon.id;

/** Up to five cases build and serve at once, so a page answers slower than on its own. */
const expectPage = playwrightExpect.configure({ timeout: 15_000 });

/**
 * A project with its own `handle`, both layout loads, a page that reads what
 * they return and a `params` file: the add-on merges into each.
 */
const existing = (cwd: string, ts: boolean): void => {
  const ext = ts ? 'ts' : 'js';
  write(cwd, `src/hooks.server.${ext}`, `${ts ? "import type { Handle } from '@sveltejs/kit/hooks';\n\n" : ''}${ts ? 'export const handle: Handle' : "/** @type {import('@sveltejs/kit/hooks').Handle} */\nexport const handle"} = async ({ event, resolve }) => {
\tconst response = await resolve(event);
\tresponse.headers.set('x-app', 'own');
\treturn response;
};
`);
  write(cwd, `src/routes/+layout.server.${ext}`, `${ts ? "import type { LayoutServerLoad } from './$types';\n\nexport const load: LayoutServerLoad" : "/** @type {import('./$types').LayoutServerLoad} */\nexport const load"} = async () => ({ user: 'Ada' });
`);
  write(cwd, `src/routes/+layout.${ext}`, `${ts ? "import type { LayoutLoad } from './$types';\n\nexport const load: LayoutLoad" : "/** @type {import('./$types').LayoutLoad} */\nexport const load"} = async ({ data }) => ({ ...data, theme: 'dark' });
`);
  write(cwd, 'src/routes/[[lang=locale]]/merged/+page.svelte', `<script${ts ? ' lang="ts"' : ''}>
${ts ? "\timport type { PageProps } from './$types';\n\n\tlet { data }: PageProps = $props();" : "\t/** @type {import('./$types').PageProps} */\n\tlet { data } = $props();"}
</script>

<p id="merged">{data.user} {data.theme}</p>
`);
  write(cwd, `src/params.${ext}`, `import { defineParams } from '@sveltejs/kit/params';

export const params = defineParams({
\tslug: (param) => (/^[a-z-]+$/.test(param) ? param : undefined),
});
`);
};

const OPTIONS = {
  locales: 'en,cs',
  format: 'curly' as const,
  routing: 'prefix' as const,
  typegen: true,
  extensions: ['typed-access', 'html', 'stores'] as ExtensionId[],
  demo: true,
};

/** What the install and the build add, which no run of the add-on writes. */
const GENERATED = ['node_modules', '.svelte-kit', 'build', 'i18n-schema.d.ts'];

/** The files of each `rerun` case after its first run. */
const firstRun = new Map<string, Record<string, string>>();

const { test, testCases } = setupTest({ [id]: addon }, {
  kinds: [
    { type: 'existing', options: { [id]: OPTIONS } },
    // A first run that stopped before its dependencies: the run `setupTest` makes then goes over its files.
    { type: 'rerun', options: { [id]: OPTIONS } },
  ],
  filter: ({ variant }) => variant.startsWith('kit'),
  browser: true,
  preAdd: async ({ addonTestCase, cwd }) => {
    existing(cwd, addonTestCase.variant === 'kit-ts');
    if (addonTestCase.kind.type !== 'rerun') return;
    const pkg = read(cwd, 'package.json');
    await add({ cwd, addons: { [id]: addon }, options: { [id]: OPTIONS } });
    firstRun.set(cwd, tree(cwd, GENERATED));
    write(cwd, 'package.json', pkg);
  },
});

test.concurrent.for(testCases)('merges into the project\'s own files, $kind.type $variant', async (testCase, { page, expect, ...ctx }) => {
  const cwd = ctx.cwd(testCase);
  const ext = testCase.variant === 'kit-ts' ? 'ts' : 'js';

  // A second run duplicates nothing: no import, `sequence`, plugin, `.gitignore` line, `use()` or `#lib` entry.
  if (testCase.kind.type === 'rerun') expect(tree(cwd, GENERATED)).toEqual(firstRun.get(cwd));

  const hooks = read(cwd, `src/hooks.server.${ext}`);
  expect(hooks).toContain('const handleAll = sequence(handle, i18nHandle);');
  const params = read(cwd, `src/params.${ext}`);
  expect(params).toContain('slug: (param) =>');
  expect(params).toContain('locale: (param) =>');

  await script(cwd, 'build');
  await script(cwd, 'check');

  const url = await serve(cwd, page, { expect, onTestFinished: ctx.onTestFinished });

  const origin = new URL(url).origin;

  // The app's own handle still runs, and both loads still reach the page beside the i18n data.
  const response = await page.goto(`${origin}/cs/merged`);
  expect(response!.headers()['x-app']).toBe('own');
  expect(await response!.text()).toContain('lang="cs"');
  await expectPage(page.locator('#merged')).toHaveText('Ada dark');

  await page.goto(`${origin}/cs/demo/sveltekit-i18n`);
  await expectPage(page.locator('h1')).toHaveText('[cs] Hello, World!');
});
