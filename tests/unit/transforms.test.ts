import { defineDemoPage } from '@sveltejs/sv-utils';
import { describe, expect, test } from 'vitest';

import { prefixDemoLink } from '../../src/demo.js';
import { hooksServer } from '../../src/hooks.js';
import { newLayout, rootLayout } from '../../src/layout.js';
import { layoutLoad } from '../../src/load.js';
import type { Routing } from '../../src/options.js';
import { addMatcher } from '../../src/params.js';

/** Runs a transform, collecting what it skipped, and runs it again over its own output, which it leaves as it is. */
const apply = (make: (skip: (reason: string) => void) => (content: string) => string | false, content: string) => {
  const skipped: string[] = [];
  const transform = make((reason) => skipped.push(reason));
  const output = transform(content);
  if (output !== false) expect(transform(output)).toBe(false);
  return { output, skipped };
};

const hooks = (content: string, routing: Routing = 'cookie', language: 'ts' | 'js' = 'ts') => (
  apply((skip) => hooksServer({ language, routing, skip }), content)
);

describe('hooks.server', () => {
  test('re-exports the handle into a module without one', () => {
    const { output, skipped } = hooks('');
    expect(output).toMatchInlineSnapshot('"export { handle } from \'#lib/i18n.js\';"');
    expect(skipped).toEqual([]);
  });

  test('sequences an exported const after the app\'s own', () => {
    const { output } = hooks(`import type { Handle } from '@sveltejs/kit/hooks';

export const handle: Handle = async ({ event, resolve }) => resolve(event);
`);
    expect(output).toMatchInlineSnapshot(`
      "import { handle as i18nHandle } from '#lib/i18n.js';
      import { type Handle, sequence } from '@sveltejs/kit/hooks';

      const handle: Handle = async ({ event, resolve }) => resolve(event);
      const handleAll = sequence(handle, i18nHandle);

      export { handleAll as handle };"
    `);
  });

  test('sequences an exported function, and reuses an imported sequence', () => {
    const { output } = hooks(`import { sequence as seq } from '@sveltejs/kit/hooks';

export async function handle({ event, resolve }) {
\treturn resolve(event);
}
`, 'cookie', 'js');
    expect(output).toMatchInlineSnapshot(`
      "import { handle as i18nHandle } from '#lib/i18n.js';
      import { sequence as seq } from '@sveltejs/kit/hooks';

      async function handle({ event, resolve }) {
      	return resolve(event);
      }

      const handleAll = seq(handle, i18nHandle);

      export { handleAll as handle };"
    `);
  });

  test('sequences a re-exported handle, keeping the other re-exports', () => {
    const { output } = hooks("export { handle, handleError } from './auth';\n");
    expect(output).toMatchInlineSnapshot(`
      "import { sequence } from '@sveltejs/kit/hooks';
      import { handle as i18nHandle } from '#lib/i18n.js';
      import { handle as originalHandle } from './auth';

      export { handleError } from './auth';
      export const handle = sequence(originalHandle, i18nHandle);"
    `);
  });

  test('wraps an existing sequence() as one handle', () => {
    const { output } = hooks(`import { sequence } from '@sveltejs/kit/hooks';

const a = async ({ event, resolve }) => resolve(event);
export const handle = sequence(a);
`);
    expect(output).toMatchInlineSnapshot(`
      "import { handle as i18nHandle } from '#lib/i18n.js';
      import { sequence } from '@sveltejs/kit/hooks';

      const a = async ({ event, resolve }) => resolve(event);
      const handle = sequence(a);
      const handleAll = sequence(handle, i18nHandle);

      export { handleAll as handle };"
    `);
  });

  test('adds the locale stub for custom routing', () => {
    const ts = hooks('', 'custom');
    expect(ts.output).toMatchInlineSnapshot(`
      "import { sequence } from '@sveltejs/kit/hooks';
      import { handle as i18nHandle } from '#lib/i18n.js';

      // Where the app's own source of the locale goes: load the user's preference
      // (from a session or a database) into \`event.locals.lang\`, which
      // \`preferredLocale\` in \`#lib/i18n\` reads.
      const handleLocale: import('@sveltejs/kit/hooks').Handle = async ({ event, resolve }) => {
      	// event.locals.lang = (await db.getUser(event.locals.userId))?.locale;
      	return resolve(event);
      };

      export const handle = sequence(handleLocale, i18nHandle);"
    `);
    expect(hooks('', 'custom', 'js').output).toMatchInlineSnapshot(`
      "import { sequence } from '@sveltejs/kit/hooks';
      import { handle as i18nHandle } from '#lib/i18n.js';

      // Where the app's own source of the locale goes: load the user's preference
      // (from a session or a database) into \`event.locals.lang\`, which
      // \`preferredLocale\` in \`#lib/i18n\` reads.
      /** @type {import('@sveltejs/kit/hooks').Handle} */
      const handleLocale = async ({ event, resolve }) => {
      	// event.locals.lang = (await db.getUser(event.locals.userId))?.locale;
      	return resolve(event);
      };

      export const handle = sequence(handleLocale, i18nHandle);"
    `);
  });

  test('sequences a re-exported handle under the name the module imports it as already', () => {
    const { output } = hooks(`import { handle as authHandle } from './auth';

export { handle } from './auth';
export const handleFetch = authHandle;
`);
    expect(output).toContain('export const handle = sequence(authHandle, i18nHandle);');
    expect(output).not.toContain('originalHandle');
  });

  test('exports the sequence under another name where the module imports a handle of that name', () => {
    const { output } = hooks(`import { handle } from './auth';

export { handle } from './auth';
`);
    expect(output).toContain('const handleAll = sequence(handle, i18nHandle);');
    expect(output).toContain('export { handleAll as handle };');
    expect(output).not.toContain('export const handle');
  });

  test('imports sequence() under a name no import of the module takes', () => {
    const { output } = hooks(`import { sequence } from './utils';

export const handle = async ({ event, resolve }) => resolve(event);
`);
    expect(output).toContain("import { sequence as sequence2 } from '@sveltejs/kit/hooks';");
    expect(output).toContain('const handleAll = sequence2(handle, i18nHandle);');
  });

  test('finds the handle past a destructuring export', () => {
    const { output } = hooks(`export const { a, b } = { a: 1, b: 2 };
export const handle = async ({ event, resolve }) => resolve(event);
`);
    expect(output).toContain('const handleAll = sequence(handle, i18nHandle);');
  });

  test('renames nothing the module names the handle by', () => {
    const { output } = hooks(`import type { Handle } from '@sveltejs/kit/hooks';

type Options = { handle: string };
type Auth = import('./auth').handle.Options;
const options: Options = { handle: 'x' };
export const handle: Handle = async ({ event, resolve }) => resolve(event);
`);
    expect(output).toContain('type Options = { handle: string };');
    expect(output).toContain("type Auth = import('./auth').handle.Options;");
    expect(output).toContain('const handle: Handle');
    expect(output).toContain('export { handleAll as handle };');
  });

  test('reports the name of the locale stub it writes, and none when it writes none', () => {
    const names: string[] = [];
    const stubbed = (content: string) => hooksServer({ language: 'ts', routing: 'custom', skip: () => {}, stub: (name) => names.push(name) })(content);
    stubbed('const handleLocale = 1;\n');
    expect(names).toEqual(['handleLocale2']);
    stubbed('const handle = async ({ event, resolve }) => resolve(event);\nexport { handle };\n');
    expect(names).toEqual(['handleLocale2']);
  });

  test('leaves a module that re-exports everything from another alone, saying so', () => {
    const { output, skipped } = hooks("export * from './auth';\n");
    expect(output).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('export *');
  });

  test('leaves a namespace exported as handle alone, as one it cannot merge into', () => {
    const { output, skipped } = hooks("export * as handle from './auth';\n");
    expect(output).toBe(false);
    expect(skipped[0]).not.toContain('may hold');
  });

  test('keeps a type imported under the name of handle', () => {
    const { output } = hooks("export const handle = async ({ event, resolve }) => resolve(event);\ntype Auth = import('./auth').handle;\ntype Own = typeof import('./auth').handle;\n");
    expect(output).toContain("type Auth = import('./auth').handle;");
    expect(output).toContain("type Own = typeof import('./auth').handle;");
  });

  test('leaves a handle it cannot merge into alone, saying so', () => {
    const { output, skipped } = hooks('const handle = async ({ event, resolve }) => resolve(event);\nexport { handle };\n');
    expect(output).toBe(false);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('sequence()');
  });

  test('leaves a module that does not parse alone, saying so', () => {
    const content = 'export const handle = ;';
    const skipped: string[] = [];
    const output = hooksServer({ language: 'ts', routing: 'cookie', skip: (reason) => skipped.push(reason) })(content);
    // sv-utils hands an unparsed file back as it was, which writes nothing.
    expect(output === false || output === content).toBe(true);
    expect(skipped).toEqual(['it does not parse.']);
  });
});

const load = (content: string, server: boolean, language: 'ts' | 'js' = 'ts') => (
  apply((skip) => layoutLoad({ language, server, skip }), content)
);

describe('layout loads', () => {
  test('assigns the i18n load to a new layout load', () => {
    expect(load('', true).output).toMatchInlineSnapshot(`
      "import { load as i18nLoad } from '#lib/i18n.js';
      import type { LayoutServerLoad } from './$types';

      export const load: LayoutServerLoad = i18nLoad;"
    `);
    expect(load('', false, 'js').output).toMatchInlineSnapshot(`
      "import { load as i18nLoad } from '#lib/i18n.js';

      /** @type {import('./$types').LayoutLoad} */
      export const load = i18nLoad;"
    `);
  });

  test('keeps an existing server load, the i18n payload last', () => {
    const { output } = load(`import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => ({ user: locals.user });
`, true);
    expect(output).toMatchInlineSnapshot(`
      "import { load as i18nLoad } from '#lib/i18n.js';
      import type { LayoutServerLoad } from './$types';

      const ownLoad = (async ({ locals }) => ({ user: locals.user })) satisfies LayoutServerLoad;

      export const load: LayoutServerLoad = async (event) => ({ ...await ownLoad(event) ?? {}, ...await i18nLoad(event) });"
    `);
  });

  test('keeps an existing universal load, data.i18n the core\'s', () => {
    const { output } = load(`/** @type {import('./$types').LayoutLoad} */
export async function load({ data }) {
\treturn { ...data, theme: 'dark' };
}
`, false, 'js');
    expect(output).toMatchInlineSnapshot(`
      "import { load as i18nLoad } from '#lib/i18n.js';

      /** @satisfies {import('./$types').LayoutLoad} */
      const ownLoad = async function ({ data }) {
      	return { ...data, theme: 'dark' };
      };

      /** @type {import('./$types').LayoutLoad} */
      export const load = async (event) => {
      	const i18n = await i18nLoad(event);
      	const own = await ownLoad(event) ?? {};

      	// The layout's own fields win, and \`data.i18n\` stays the instance \`use()\` takes.
      	return { ...i18n, ...own, i18n: i18n.i18n };
      };"
    `);
  });

  test('types an untyped existing load by what it returns, its argument by the layout\'s load type', () => {
    const ts = load(`export async function load({ data }) {
\treturn { ...data, theme: 'dark' };
}
`, false);
    expect(ts.output).toMatchInlineSnapshot(`
      "import { load as i18nLoad } from '#lib/i18n.js';
      import type { LayoutLoad } from './$types';

      const ownLoad = async function ({ data }) {
      	return { ...data, theme: 'dark' };
      } satisfies LayoutLoad;

      export const load: LayoutLoad = async (event) => {
      	const i18n = await i18nLoad(event);
      	const own = await ownLoad(event) ?? {};

      	// The layout's own fields win, and \`data.i18n\` stays the instance \`use()\` takes.
      	return { ...i18n, ...own, i18n: i18n.i18n };
      };"
    `);
    expect(load('export const load = async ({ data }) => ({ ...data, theme: \'dark\' });\n', false, 'js').output).toMatchInlineSnapshot(`
      "import { load as i18nLoad } from '#lib/i18n.js';

      /**
       * @satisfies {import('./$types').LayoutLoad}
       */
      const ownLoad = async ({ data }) => ({ ...data, theme: 'dark' });

      /** @type {import('./$types').LayoutLoad} */
      export const load = async (event) => {
      	const i18n = await i18nLoad(event);
      	const own = await ownLoad(event) ?? {};

      	// The layout's own fields win, and \`data.i18n\` stays the instance \`use()\` takes.
      	return { ...i18n, ...own, i18n: i18n.i18n };
      };"
    `);
  });

  test('types an existing JavaScript load in a JSDoc of its own, after the one it has', () => {
    const typed = (jsdoc: string) => load(`${jsdoc}\nexport const load = async ({ locals }) => ({ user: locals.user });\n`, true, 'js').output;
    const satisfies = "@satisfies {import('./$types').LayoutServerLoad}";
    expect(load('/** The user. */\nexport async function load({ locals }) {\n\treturn { user: locals.user };\n}\n', true, 'js').output)
      .toContain(`/** The user. */\n/** ${satisfies} */\nconst ownLoad = async function ({ locals }) {`);
    // TypeScript reads the last JSDoc alone, whatever the one before it holds.
    for (const jsdoc of [
      '/** The user. **/',
      '/**\n * The *user*.\n * ***\n **/',
      '/** Use `@satisfies {T}` on it. */',
      "/** @type import('./$types').LayoutServerLoad */",
      "/**\n * The user.\n * @type {import('./$types').LayoutServerLoad}\n * @deprecated\n */",
    ]) {
      expect(typed(jsdoc)).toContain(`${jsdoc}\n/** ${satisfies} */\nconst ownLoad = async ({ locals }) => `);
    }
    expect(load('/** The user. */ export const load = async ({ locals }) => ({ user: locals.user });\n', true, 'js').output)
      .toContain(`/** The user. */ /** ${satisfies} */ const ownLoad = async ({ locals }) => `);
  });

  test('turns the one type tag of a JavaScript load\'s JSDoc into @satisfies', () => {
    const typed = (jsdoc: string) => load(`${jsdoc}\nexport const load = async ({ locals }) => ({ user: locals.user });\n`, true, 'js').output;
    const type = "{import('./$types').LayoutServerLoad}";
    expect(typed(`/**@type ${type}*/`)).toContain(`/**@satisfies ${type}*/\nconst ownLoad = `);
    expect(typed(`/**\n * The user.\n *@type${type}\n */`)).toContain(`/**\n * The user.\n *@satisfies${type}\n */\nconst ownLoad = `);
    expect(typed(`/** @satisfies ${type} */`)).toContain(`/** @satisfies ${type} */\nconst ownLoad = `);
    expect(typed(`/**\n *@satisfies ${type}\n */`)).toContain(`/**\n *@satisfies ${type}\n */\nconst ownLoad = `);
  });

  test('leaves a JavaScript load with a JSDoc inside its declaration alone, saying so', () => {
    for (const content of [
      "export const load = /** @type {import('./$types').LayoutServerLoad} */ (async ({ locals }) => ({ user: locals.user }));\n",
      "export /** @type {import('./$types').LayoutServerLoad} */ const load = async ({ locals }) => ({ user: locals.user });\n",
      "export const /** @type {import('./$types').LayoutServerLoad} */ load = async ({ locals }) => ({ user: locals.user });\n",
      'export /** The user. */ async function load({ locals }) {\n\treturn { user: locals.user };\n}\n',
    ]) {
      const { output, skipped } = load(content, true, 'js');
      expect(output).toBe(false);
      expect(skipped[0]).toContain('a JSDoc inside');
    }
  });

  test('leaves a JavaScript load typed by the tags of its JSDoc alone, saying so', () => {
    for (const tags of [
      " * @param {import('./$types').LayoutServerLoadEvent} event\n * @returns {Promise<{ user: { name: string } }>}",
      ' * @return {Promise<{ tags: string[] }>}',
      ' * @template T\n * @arg {T} event',
      ' * @this {Window}',
    ]) {
      const { output, skipped } = load(`/**\n * Loads the user.\n${tags}\n */\nexport async function load({ locals }) {\n\treturn { user: locals.user };\n}\n`, true, 'js');
      expect(output).toBe(false);
      expect(skipped[0]).toContain('`@returns`');
    }
  });

  test('calls an existing load that takes no argument without one', () => {
    expect(load('export const load = async () => ({ user: \'Ada\' });\n', true).output).toContain('...await ownLoad() ?? {},');
  });

  test('keeps an existing load that returns nothing', () => {
    expect(load('export const load = async ({ depends }) => { depends(\'app:x\'); };\n', true).output)
      .toContain('({ ...await ownLoad(event) ?? {}, ...await i18nLoad(event) })');
    expect(load('export const load = async ({ depends }) => { depends(\'app:x\'); };\n', false).output)
      .toContain('const own = await ownLoad(event) ?? {};');
  });

  test('exports the new load last, after everything the module evaluates', () => {
    const { output } = load(`export const load = async () => ({ user: 'Ada' });
export const prerender = true;
`, true);
    expect(output).toMatch(/const ownLoad = [^]*export const prerender = true;\n+export const load: LayoutServerLoad = [^\n]*$/);
  });

  test('leaves the comments of the module where they are, but for the last ones', () => {
    const ts = load(`export const load = async () => ({ a: 1 });

// @ts-expect-error -- not in the types yet
export const config: { runtime: 'edge' } = { runtime: 'nodejs' };
`, true).output;
    expect(ts).toMatch(/\n\/\/ @ts-expect-error -- not in the types yet\nexport const config/);
    const js = load(`export const load = async () => ({ a: 1 });

/** @type {import('./config').Config} */
export const config = { runtime: 'nodejs' };
`, false, 'js').output;
    expect(js).toMatch(/\/\*\* @type \{import\('\.\/config'\)\.Config\} \*\/\nexport const config/);
    const chained = load('export const prerender = true; /* Every page,\n   at build time. */ // Static.\nexport const ssr = false; // No server.\n', true).output;
    expect(chained).toContain('export const prerender = true; /* Every page,\n   at build time. */');
    expect(chained).toContain('// Static.\nexport const ssr = false; // No server.');
    expect(chained).toMatch(/export const load: LayoutServerLoad = i18nLoad;$/);
    // What follows the last statement is followed by the new export, as in `hooks.server`.
    expect(load('export const prerender = true;\n// The end.\n', true, 'js').output)
      .toMatch(/\/\/ The end\.\n\/\*\* @type \{import\('\.\/\$types'\)\.LayoutServerLoad\} \*\/\nexport const load = i18nLoad;$/);
  });

  test('leaves a module that reads load as it is evaluated alone, saying so', () => {
    for (const content of [
      'export const load = async () => ({});\nexport const _loaders = [load];\n',
      'export const _loaders = [load];\nexport async function load() {\n\treturn {};\n}\n',
      'export const load = async () => ({});\nconst o = { load };\n',
      'export const load = async () => ({});\nload satisfies unknown;\n',
      'export const load = async () => ({});\nexport const _kind = typeof load;\n',
      'export const load = async () => ({});\nclass C {\n\tstatic x = load;\n}\n',
    ]) {
      const { output, skipped } = load(content, true);
      expect(output).toBe(false);
      expect(skipped[0]).toContain('as it is evaluated');
    }
  });

  test('merges into a module that reads load only once it runs', () => {
    for (const content of [
      'export const load = async () => ({});\nexport const _later = () => load();\n',
      'export const load = async () => ({});\nexport type Own = Awaited<ReturnType<typeof load>>;\n',
      'type O = { load: string };\nexport const _read = (o: O) => o.load;\nexport const load = async () => ({});\n',
    ]) expect(load(content, true).output).toContain('export const load: LayoutServerLoad =');
  });

  test('calls a load that satisfies its type already by what it takes', () => {
    const { output } = load(`import type { LayoutServerLoad } from './$types';

export const load = (async () => ({ a: 1 })) satisfies LayoutServerLoad;
`, true);
    expect(output).toContain('...await ownLoad() ?? {},');
  });

  test('leaves a module that names something load without exporting it alone, saying so', () => {
    const { output, skipped } = load("import { load } from 'js-yaml';\n\nexport const prerender = true;\n", true);
    expect(output).toBe(false);
    expect(skipped[0]).toContain('does not export');
  });

  test('adds the load beside a load the module scope does not bind', () => {
    for (const content of [
      'const run = (load: () => Promise<void>) => load();\n',
      'type Loader = { load: () => Promise<void> };\n',
      'function f() {\n\tconst load = 1;\n\treturn load;\n}\n',
    ]) expect(load(content, true).output).toContain('export const load: LayoutServerLoad = i18nLoad;');
    for (const content of ["import { safeLoad as load } from 'js-yaml';\n", 'function load() {}\n', 'const { load } = { load: 1 };\n']) {
      expect(load(content, true).skipped[0]).toContain('does not export');
    }
  });

  test('leaves an overloaded load alone, saying so', () => {
    const { output, skipped } = load(`export function load(event: { a: 1 }): { a: 1 };
export function load(event: unknown) { return { a: 1 }; }
`, true);
    expect(output).toBe(false);
    expect(skipped[0]).toContain('overloads');
  });

  test('leaves a load declared with let alone, saying so', () => {
    const { output, skipped } = load('export let load = async () => ({});\n', true);
    expect(output).toBe(false);
    expect(skipped[0]).toContain('with `let`');
  });

  test('reuses the load type imported from ./$types.js', () => {
    const { output } = load(`import type { LayoutServerLoad } from './$types.js';

export const load: LayoutServerLoad = async ({ locals }) => ({ user: locals.user });
`, true);
    expect(output).not.toContain("from './$types';");
    expect(output).toContain('export const load: LayoutServerLoad =');
  });

  test('leaves a module that re-exports everything from another alone, saying so', () => {
    const { output, skipped } = load("export * from './shared';\n", true);
    expect(output).toBe(false);
    expect(skipped[0]).toContain('export *');
  });

  test('leaves a re-exported load alone, saying so', () => {
    const { output, skipped } = load("export { load } from './shared';\n", false);
    expect(output).toBe(false);
    expect(skipped).toHaveLength(1);
  });
});

const layout = (content: string, language: 'ts' | 'js' = 'ts') => (
  apply((skip) => rootLayout({ language, skip }), content)
);

describe('root layout', () => {
  test('a new layout hands data to use()', () => {
    expect(newLayout('ts')).toMatchInlineSnapshot(`
      "<script lang="ts">
      	import { use } from '#lib/i18n.js';
      	import type { LayoutProps } from './$types';

      	let { data, children }: LayoutProps = $props();

      	use(() => data);
      </script>

      {@render children()}
      "
    `);
    expect(newLayout('js')).toMatchInlineSnapshot(`
      "<script>
      	import { use } from '#lib/i18n.js';

      	/** @type {import('./$types').LayoutProps} */
      	let { data, children } = $props();

      	use(() => data);
      </script>

      {@render children()}
      "
    `);
  });

  test('takes data from the existing props and types them', () => {
    const { output } = layout(`<script lang="ts">
\tlet { children } = $props();
</script>

{@render children()}
`);
    expect(output).toMatchInlineSnapshot(`
      "<script lang="ts">
      	import { use } from '#lib/i18n.js';
      	import type { LayoutProps } from './$types';

      	let { children, data }: LayoutProps = $props();

      	use(() => data);
      </script>

      {@render children()}"
    `);
  });

  test('reads data under the name it has, keeping the type the props have', () => {
    const { output } = layout(`<script>
\t/** @type {{ data: any, children: any }} */
\tlet { data: pageData, children } = $props();
</script>

{@render children()}
`, 'js');
    expect(output).toMatchInlineSnapshot(`
      "<script>
      	import { use } from '#lib/i18n.js';

      	/** @type {{ data: any, children: any }} */
      	let { data: pageData, children } = $props();

      	use(() => pageData);
      </script>

      {@render children()}"
    `);
  });

  test('reads data off props kept whole', () => {
    const { output } = layout(`<script lang="ts">
\tlet props = $props();
</script>

{@render props.children()}
`);
    expect(output).toMatchInlineSnapshot(`
      "<script lang="ts">
      	import { use } from '#lib/i18n.js';
      	import type { LayoutProps } from './$types';

      	let props: LayoutProps = $props();

      	use(() => props.data);
      </script>

      {@render props.children()}"
    `);
  });

  test('reads data off the rest of the props, which keeps it', () => {
    const { output } = layout(`<script lang="ts">
\tlet { children, ...rest } = $props();
</script>

<h1>{rest.data.title}</h1>
{@render children()}
`);
    expect(output).toContain('let { children, ...rest }: LayoutProps = $props();');
    expect(output).toContain('use(() => rest.data);');
  });

  test('keeps a type of the props of its own', () => {
    const ts = layout(`<script lang="ts">
\timport type { Snippet } from 'svelte';
\timport type { LayoutData } from './$types';

\tlet { data, children, extra = 1 }: { data: LayoutData; children: Snippet; extra?: number } = $props();
</script>
`);
    expect(ts.output).toContain('let { data, children, extra = 1 }: { data: LayoutData; children: Snippet; extra?: number } = $props();');
    expect(ts.output).not.toContain('LayoutProps');
  });

  test('declares the data it takes in a type of the props of their own', () => {
    // sv's own template, in JavaScript.
    const template = layout(`<script>
\t/** @type {{children: import('svelte').Snippet}} */
\tlet { children } = $props();
</script>
`, 'js');
    expect(template.output).toContain("/** @type {{children: import('svelte').Snippet, data: import('./$types').LayoutData}} */");

    const literal = layout(`<script lang="ts">
\timport type { Snippet } from 'svelte';

\tlet { children }: { children: Snippet } = $props();
</script>
`);
    expect(literal.output).toContain("import type { LayoutData } from './$types';");
    expect(literal.output).toContain('let { children, data }: { children: Snippet; data: LayoutData } = $props();');

    const named = layout(`<script lang="ts">
\timport type { Props } from './props';

\tlet { children }: Props = $props();
</script>
`);
    expect(named.output).toContain('let { children, data }: Props & { data: LayoutData } = $props();');

    const union = layout(`<script>
\t/** @type {A | B} */
\tlet { children } = $props();
</script>
`, 'js');
    expect(union.output).toContain("/** @type {(A | B) & { data: import('./$types').LayoutData }} */");

    const props = layout(`<script>
\t/** @type {import('./$types').LayoutProps} */
\tlet { children } = $props();
</script>
`, 'js');
    expect(props.output).toContain("/** @type {import('./$types').LayoutProps} */");
  });

  test('declares data in a type of the props read whole or through a rest', () => {
    const whole = layout(`<script lang="ts">
\tlet props: { children: Snippet } = $props();
</script>
`);
    expect(whole.output).toContain('let props: { children: Snippet; data: LayoutData } = $props();');
    const rest = layout(`<script lang="ts">
\tlet { children, ...rest }: { children: Snippet } = $props();
</script>
`);
    expect(rest.output).toContain('let { children, ...rest }: { children: Snippet; data: LayoutData } = $props();');
  });

  test('declares data in a type of the props of any shape', () => {
    const js = (type: string) => layout(`<script>
\t/** @type ${type} */
\tlet { children } = $props();
</script>
`, 'js').output as string;
    expect(js('{ { children: any } }')).toContain("/** @type { { children: any, data: import('./$types').LayoutData } } */");
    expect(js("{{ children: any, title?: '}' }}")).toContain("/** @type {{ children: any, title?: '}', data: import('./$types').LayoutData }} */");
    expect(js("{{ children: any, 'data': string }}")).toContain("/** @type {{ children: any, 'data': string }} */");
    expect(layout(`<script>
\t/**
\t * @type {{
\t *   children: import('svelte').Snippet
\t * }}
\t */
\tlet { children } = $props();
</script>
`, 'js').output).toContain("children: import('svelte').Snippet, data: import('./$types').LayoutData\n\t * }}");

    const ts = (type: string) => layout(`<script lang="ts">
\tlet { children }: ${type} = $props();
</script>
`).output as string;
    expect(ts('A | B')).toContain('let { children, data }: (A | B) & { data: LayoutData } = $props();');
    expect(ts("{ children: any; 'data': string }")).toContain("let { children, data }: { children: any; 'data': string } = $props();");
  });

  test('reuses LayoutProps imported from ./$types.js', () => {
    const { output } = layout(`<script lang="ts">
\timport type { LayoutProps } from './$types.js';

\tlet { children } = $props();
</script>
`);
    expect(output).not.toContain("from './$types';");
    expect(output).toContain('let { children, data }: LayoutProps = $props();');
  });

  test('names data apart from a snippet of the template', () => {
    const { output } = layout(`<script lang="ts">
\tlet { children } = $props();
</script>

{#snippet data()}<p>x</p>{/snippet}
{@render children()}
`);
    expect(output).toContain('let { children, data: data2 }: LayoutProps = $props();');
    expect(output).toContain('use(() => data2);');
  });

  test('leaves a layout that declares its props with export let alone, saying so', () => {
    const { output, skipped } = layout(`<script>
\texport let data;
</script>

<slot />
`, 'js');
    expect(output).toBe(false);
    expect(skipped[0]).toContain('export let');
  });

  test('leaves data destructured further alone, saying so', () => {
    const { output, skipped } = layout(`<script>
\tlet { data: { user }, children } = $props();
</script>
`, 'js');
    expect(output).toBe(false);
    expect(skipped).toHaveLength(1);
  });
});

describe('params', () => {
  const matcher = (content: string) => apply((skip) => addMatcher({ from: '#lib/locale.ts', skip }), content);

  test('adds the locale matcher to an existing params file', () => {
    const { output } = matcher(`import { defineParams } from '@sveltejs/kit/params';

export const params = defineParams({
\tslug: (param) => param,
});
`);
    expect(output).toMatchInlineSnapshot(`
      "import { isPrefixed } from '#lib/locale.ts';
      import { defineParams } from '@sveltejs/kit/params';

      export const params = defineParams({
      	slug: (param) => param,
      	locale: (param) => isPrefixed(param) ? param : undefined
      });"
    `);
  });

  test('leaves a file without defineParams, or with a locale matcher, alone', () => {
    expect(matcher('export const params = {};\n').skipped).toHaveLength(1);
    const taken = matcher(`import { defineParams } from '@sveltejs/kit/params';

export const params = defineParams({ locale: (param) => param });
`);
    expect(taken.output).toBe(false);
    expect(taken.skipped[0]).toContain('isPrefixed');
  });
});

describe('demo link', () => {
  test('points the generated entry at the prefixed route, once', () => {
    const [, links] = defineDemoPage('sveltekit-i18n', 'ts', 'src/routes').links;
    const prefix = prefixDemoLink('ts', '/[[lang=locale]]/demo/sveltekit-i18n');
    const first = links('');
    expect(first).toContain("resolve('/demo/sveltekit-i18n')");

    const output = prefix(first as string);
    expect(output).toContain("resolve('/[[lang=locale]]/demo/sveltekit-i18n', {})");
    expect(output).not.toContain("resolve('/demo/sveltekit-i18n')");
    expect(prefix(output as string)).toBe(false);

    // A second run of sv's own transform adds its entry again, which then goes.
    const again = links(output as string);
    expect(again).toContain("resolve('/demo/sveltekit-i18n')");
    expect(prefix(again as string)).toBe(output);
  });
});
