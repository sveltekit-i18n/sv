import fs from 'node:fs';
import path from 'node:path';

import { add } from 'sv';
import { describe, expect, inject, test } from 'vitest';

import addon from '../../src/index.js';
import { edit, fromTemplate, read, tree } from '../setup/project.js';

/** Every option, as the command line hands them on once it has asked for the missing ones. */
const DEFAULTS = { locales: 'en', format: 'curly', routing: 'cookie', typegen: true, extensions: [], demo: true };

/** A fresh kit-ts project named `name`, changed by `prepare`. */
const project = (name: string, prepare: (cwd: string) => void = () => {}): string => {
  const cwd = fromTemplate(path.join(inject('testDir'), 'run', name), 'kit-ts');
  prepare(cwd);
  return cwd;
};

const depend = (name: string, version: string) => (cwd: string): void => edit(cwd, 'package.json', (content) => {
  const data = JSON.parse(content) as { dependencies?: Record<string, string> };
  return JSON.stringify({ ...data, dependencies: { ...data.dependencies, [name]: version } }, null, '\t');
});

const run = async (cwd: string, options: Record<string, unknown>) => {
  const { status } = await add({ cwd, addons: { [addon.id]: addon }, options: { [addon.id]: options } });
  return status[addon.id];
};

/** What the CLI prints after a run, read as `sv` reads it: from the options alone. */
const nextSteps = (options: Record<string, unknown>): string[] => addon.nextSteps?.({
  options: { ...DEFAULTS, ...options },
  language: 'ts',
  directory: { src: 'src', lib: 'src/lib', kitRoutes: 'src/routes' },
} as unknown as Parameters<NonNullable<typeof addon.nextSteps>>[0]) ?? [];

/** Runs the add-on and returns why it canceled, failing if it wrote anything. */
const cancels = async (cwd: string, options: Record<string, unknown> = {}): Promise<string[]> => {
  const before = tree(cwd);
  const status = await run(cwd, options);
  expect(tree(cwd)).toEqual(before);
  expect(status).toBeInstanceOf(Array);
  return status as string[];
};

describe('cancels before any write', () => {
  test('a project set up already', async () => {
    const [current] = await cancels(project('installed', depend('sveltekit-i18n', '^3.4.1')));
    expect(current).toContain('depends on `sveltekit-i18n` already');
    expect(current).not.toContain('v2');

    const [old] = await cancels(project('installed-v2', depend('sveltekit-i18n', '^2.4.2')));
    expect(old).toContain('TROUBLESHOOTING.md#upgrading-from-v2');

    const [base] = await cancels(project('installed-base', depend('@sveltekit-i18n/base', '^3.3.2')));
    expect(base).toContain('`@sveltekit-i18n/base`');
  });

  test('an option the command line passed unread', async () => {
    const [reason] = await cancels(project('option'), { locales: 'en,en_US' });
    expect(reason).toBe('Not a locale: en_US.');
  });

  test('routing: prefix under a base the add-on cannot read', async () => {
    const cwd = project('base', (dir) => edit(dir, 'vite.config.ts', (content) => content.replace('adapter: adapter()', 'adapter: adapter(),\n\t\t\tpaths: { base: process.env.BASE_PATH }')));
    expect(read(cwd, 'vite.config.ts')).toContain('process.env.BASE_PATH');
    const [reason] = await cancels(cwd, { routing: 'prefix' });
    expect(reason).toContain('`kit.paths.base` as a string literal');
    const [translated] = await cancels(cwd, { routing: 'translated' });
    expect(translated).toContain('`routing: translated` needs `kit.paths.base` as a string literal');
  });

  test('an i18n module of another setup', async () => {
    const [reason] = await cancels(project('i18n', (dir) => edit(dir, 'src/lib/i18n.ts', () => 'export const t = (key: string) => key;\n')));
    expect(reason).toContain('src/lib/i18n.ts');
  });

  test('routing: translated beside an i18n module short of what the generated files import', async () => {
    const i18n = "import { defineI18n } from 'sveltekit-i18n/kit';\n\nexport const { handle, load, use, get } = defineI18n({});\n";
    const [reason] = await cancels(project('i18n-short', (dir) => edit(dir, 'src/lib/i18n.ts', () => i18n)), { routing: 'translated' });
    expect(reason).toContain('`reroute`, `delocalize`, `localizePath`');
    expect(reason).toContain('#translated-pathnames');

    const based = project('i18n-short-base', (dir) => {
      edit(dir, 'src/lib/i18n.ts', () => i18n.replace('get }', 'get, reroute, delocalize, localizePath }'));
      edit(dir, 'vite.config.ts', (content) => content.replace('adapter: adapter()', "adapter: adapter(),\n\t\t\tpaths: { base: '/app' }"));
    });
    const [config] = await cancels(based, { routing: 'translated' });
    expect(config).toContain('does not export `config`');

    const [broken] = await cancels(project('i18n-unparsed', (dir) => edit(dir, 'src/lib/i18n.ts', () => 'export const = defineI18n;\n')), { routing: 'translated' });
    expect(broken).toContain('does not parse');
  });

  test('routing: prefix beside a locale module of another setup', async () => {
    const cwd = project('locale', (dir) => edit(dir, 'src/lib/locale.ts', () => "export const locale = 'en';\n"));
    const [reason] = await cancels(cwd, { routing: 'prefix' });
    expect(reason).toContain('src/lib/locale.ts');
  });

  test('routing: prefix beside a locale module short of what the generated files import', async () => {
    const cwd = project('locale-short', (dir) => edit(dir, 'src/lib/locale.ts', () => 'export const localeOf = (pathname: string) => pathname;\n'));
    const [reason] = await cancels(cwd, { routing: 'prefix' });
    expect(reason).toContain('src/lib/locale.ts');
    expect(reason).toContain('`isPrefixed`');
    expect(reason).toContain('`pathOf`');

    const unparsed = project('locale-unparsed', (dir) => edit(dir, 'src/lib/locale.ts', () => 'export const = ;\n'));
    const [broken] = await cancels(unparsed, { routing: 'prefix' });
    expect(broken).toContain('does not parse');

    const namespaced = project('locale-namespace', (dir) => edit(dir, 'src/lib/locale.ts', () => "export * as helpers from './helpers';\n"));
    const [why] = await cancels(namespaced, { routing: 'prefix' });
    expect(why).toContain('`localeOf`');
  });

  test('routing: prefix keeps a locale module that has what the generated files import', async () => {
    // Without the demo, nothing imports the helpers it links with.
    const helpers = project('locale-helpers', (dir) => edit(dir, 'src/lib/locale.ts', () => 'export const localeOf = (pathname: string) => pathname;\nexport const isPrefixed = (segment: string) => !!segment;\n'));
    expect(await run(helpers, { ...DEFAULTS, routing: 'prefix', demo: false })).not.toBeInstanceOf(Array);
    expect(read(helpers, 'src/lib/locale.ts')).not.toContain('pathOf');

    // An `export *` may export anything, and is taken at its word.
    const starred = project('locale-star', (dir) => edit(dir, 'src/lib/locale.ts', () => "export * from './helpers';\n"));
    expect(await run(starred, { ...DEFAULTS, routing: 'prefix', demo: false })).not.toBeInstanceOf(Array);
    expect(read(starred, 'src/lib/locale.ts')).toBe("export * from './helpers';\n");
  });
});

describe('leaves a file alone, and says so', () => {
  test('a hooks file that does not parse, and a handle it does not merge into', async () => {
    const broken = 'export const handle = ;\n';
    const cwd = project('unparsed', (dir) => {
      edit(dir, 'src/hooks.server.ts', () => broken);
      edit(dir, 'src/routes/+layout.server.ts', () => 'const load = async () => ({});\nexport { load };\n');
    });
    expect(await run(cwd, DEFAULTS)).toBe('success');

    expect(read(cwd, 'src/hooks.server.ts')).toBe(broken);
    expect(read(cwd, 'src/routes/+layout.server.ts')).toBe('const load = async () => ({});\nexport { load };\n');
    // The rest is written.
    expect(read(cwd, 'src/lib/i18n.ts')).toContain('defineI18n');
    expect(read(cwd, 'src/routes/+layout.ts')).toContain('i18nLoad');

    const steps = nextSteps(DEFAULTS).join('\n');
    expect(steps).toContain('src/hooks.server.ts');
    expect(steps).toContain('it does not parse.');
    expect(steps).toContain('src/routes/+layout.server.ts');
  });

  test('another i18n library, and a base the add-on cannot read', async () => {
    const cwd = project('notes', (dir) => {
      depend('svelte-i18n', '^4.0.0')(dir);
      edit(dir, 'vite.config.ts', (content) => content.replace('adapter: adapter()', 'adapter: adapter(),\n\t\t\tpaths: { base: process.env.BASE_PATH }'));
    });
    expect(await run(cwd, DEFAULTS)).toBe('success');
    expect(read(cwd, 'src/lib/i18n.ts')).not.toContain('basePath');

    const steps = nextSteps(DEFAULTS).join('\n');
    expect(steps).toContain('svelte-i18n');
    expect(steps).toContain('kit.paths.base');
  });

  test('custom routing names the locale stub it wrote, and says what to add when it wrote none', async () => {
    const custom = { ...DEFAULTS, routing: 'custom' };
    const stubbed = project('custom-stub', (dir) => edit(dir, 'src/hooks.server.ts', () => 'export const handleLocale = 1;\n'));
    expect(await run(stubbed, custom)).toBe('success');
    expect(read(stubbed, 'src/hooks.server.ts')).toContain('const handleLocale2');
    expect(nextSteps(custom).join('\n')).toContain('`handleLocale2` stub');

    const skipped = project('custom-skipped', (dir) => edit(dir, 'src/hooks.server.ts', () => 'const handle = async ({ event, resolve }) => resolve(event);\nexport { handle };\n'));
    expect(await run(skipped, custom)).toBe('success');
    const steps = nextSteps(custom).join('\n');
    expect(steps).not.toContain('stub');
    expect(steps).toContain('fills `event.locals.lang`');
  });

  test('merges into the hooks and params Kit reads: a directory\'s index first, then JavaScript', async () => {
    const hooks = 'export const handle = async ({ event, resolve }) => resolve(event);\n';
    const params = "import { defineParams } from '@sveltejs/kit/params';\n\nexport const params = defineParams({});\n";
    const prefix = { ...DEFAULTS, locales: 'en,cs', routing: 'prefix' };
    const index = project('kit-index', (dir) => {
      for (const file of ['src/hooks.server/index.ts', 'src/hooks.server.ts']) edit(dir, file, () => hooks);
      for (const file of ['src/params/index.ts', 'src/params.ts']) edit(dir, file, () => params);
    });
    expect(await run(index, prefix)).toBe('success');
    expect(read(index, 'src/hooks.server/index.ts')).toContain('sequence(handle, i18nHandle)');
    expect(read(index, 'src/params/index.ts')).toContain('locale: (param) =>');
    expect(read(index, 'src/hooks.server.ts')).toBe(hooks);
    expect(read(index, 'src/params.ts')).toBe(params);
    expect(nextSteps(prefix).join('\n')).toContain('imports src/params/index.ts and src/lib/locale.ts with the runtime itself');

    const js = project('kit-js', (dir) => {
      for (const file of ['src/hooks.server.js', 'src/hooks.server.ts']) edit(dir, file, () => hooks);
      for (const file of ['src/params.js', 'src/params.ts']) edit(dir, file, () => params);
    });
    expect(await run(js, prefix)).toBe('success');
    expect(read(js, 'src/hooks.server.js')).toContain('sequence(handle, i18nHandle)');
    expect(read(js, 'src/params.js')).toContain('locale: (param) =>');
    expect(read(js, 'src/hooks.server.ts')).toBe(hooks);
    expect(read(js, 'src/params.ts')).toBe(params);
    // A JavaScript `params` still imports the TypeScript locale helpers.
    expect(nextSteps(prefix).join('\n')).toContain('imports src/lib/locale.ts with the runtime itself');

    // With JavaScript locale helpers too, Node strips nothing.
    const plain = project('kit-plain-js', (dir) => {
      edit(dir, 'src/params.js', () => params);
      edit(dir, 'src/lib/locale.js', () => 'export const localeOf = () => {};\nexport const isPrefixed = () => {};\nexport const LOCALES = [];\nexport const pathOf = () => {};\nexport const routeOf = () => {};\n');
    });
    expect(await run(plain, prefix)).toBe('success');
    expect(read(plain, 'src/params.js')).toContain("from '#lib/locale.js'");
    expect(nextSteps(prefix).join('\n')).not.toContain('strips types');
  });

  test('translated routing re-exports reroute from the module Kit reads, and leaves one of the app\'s own alone', async () => {
    const translated = { ...DEFAULTS, locales: 'en,cs', routing: 'translated' };
    const index = project('universal-index', (dir) => edit(dir, 'src/hooks/index.ts', () => 'export const transport = {};\n'));
    expect(await run(index, translated)).toBe('success');
    expect(read(index, 'src/hooks/index.ts')).toContain("export { reroute } from '#lib/i18n.js';");
    expect(fs.existsSync(path.join(index, 'src/hooks.ts'))).toBe(false);

    const javascript = project('universal-js', (dir) => edit(dir, 'src/hooks.js', () => 'export const transport = {};\n'));
    expect(await run(javascript, translated)).toBe('success');
    expect(read(javascript, 'src/hooks.js')).toContain("export { reroute } from '#lib/i18n.js';");
    expect(fs.existsSync(path.join(javascript, 'src/hooks.ts'))).toBe(false);

    const own = 'export const reroute = () => undefined;\n';
    const rerouted = project('universal-own', (dir) => edit(dir, 'src/hooks.ts', () => own));
    expect(await run(rerouted, translated)).toBe('success');
    expect(read(rerouted, 'src/hooks.ts')).toBe(own);
    expect(nextSteps(translated).join('\n')).toContain('a `reroute` of its own');
  });

  test('translated routing names the routes its catch-all takes from the app', async () => {
    const translated = { ...DEFAULTS, locales: 'en,cs', routing: 'translated' };
    const cwd = project('translated-taken', (dir) => {
      edit(dir, 'src/routes/cs/+page.svelte', () => '<h1>cs</h1>\n');
      edit(dir, 'src/routes/CS/+page.svelte', () => '<h1>CS</h1>\n');
      edit(dir, 'src/routes/(app)/[[lang]]/+page.svelte', () => '<h1>lang</h1>\n');
      edit(dir, 'src/routes/[lang=locale]/about/+page.svelte', () => '<h1>about</h1>\n');
      edit(dir, 'src/routes/(docs)/[lang=supported-locale]/guide/+page.svelte', () => '<h1>guide</h1>\n');
      edit(dir, 'src/routes/(shop)/[current-lang=locale]/cart/+page.svelte', () => '<h1>cart</h1>\n');
      edit(dir, 'src/routes/[lang-code]/+page.svelte', () => '<h1>code</h1>\n');
      edit(dir, 'src/routes/en/+page.svelte', () => '<h1>en</h1>\n');
      edit(dir, 'src/routes/[slug]/+page.svelte', () => '<h1>slug</h1>\n');
      edit(dir, 'src/routes/[...rest]/+page.svelte', () => '<h1>404</h1>\n');
    });
    expect(await run(cwd, translated)).toBe('success');
    const steps = nextSteps(translated).join('\n');
    expect(steps).toContain('src/routes/cs');
    expect(steps).toContain('src/routes/(app)/[[lang]]');
    expect(steps).toContain('src/routes/[lang=locale]');
    expect(steps).toContain('src/routes/(docs)/[lang=supported-locale]');
    expect(steps).toContain('src/routes/(shop)/[current-lang=locale]');
    expect(steps).not.toContain('src/routes/[lang-code]');
    // The catch-all's prefix matches as it is spelled, so `/CS` stays the default locale's.
    expect(steps).not.toContain('src/routes/CS');
    expect(steps).not.toContain('src/routes/en');
    expect(steps).not.toContain('src/routes/[slug]');
    expect(steps).not.toContain('src/routes/[...rest]');
  });

  test('translated routing asks for the redirect where it left hooks.server alone, and lists a prerendered pathname with a second locale only', async () => {
    const translated = { ...DEFAULTS, locales: 'en,cs', routing: 'translated' };
    const cwd = project('translated-skipped', (dir) => edit(dir, 'src/hooks.server.ts', () => 'const handle = async ({ event, resolve }) => resolve(event);\nexport { handle };\n'));
    expect(await run(cwd, translated)).toBe('success');
    const steps = nextSteps(translated).join('\n');
    expect(steps).toContain('Run the redirect of *One page, one pathname per locale* before it');
    expect(steps).toContain('`/cs` for a prerendered home page');

    const single = { ...translated, locales: 'en' };
    expect(await run(project('translated-single'), single)).toBe('success');
    const once = nextSteps(single).join('\n');
    expect(once).not.toContain('prerender.entries');
    expect(once).not.toContain('Run the redirect');
  });

  test('prefix routing links through resolve(), and needs a Node that strips types on Node only', async () => {
    const prefix = { ...DEFAULTS, routing: 'prefix' };
    expect(await run(project('prefix-steps'), prefix)).toBe('success');
    const steps = nextSteps(prefix).join('\n');
    expect(steps).toContain('resolve(pathOf(');
    expect(steps).toContain('On Node, build on 22.18 or newer (23.6 on Node 23): Kit\'s build imports src/params.ts and src/lib/locale.ts with');
  });

  test('a Vite config under a name sv does not edit', async () => {
    const cwd = project('vite-mjs', (dir) => {
      fs.renameSync(path.join(dir, 'vite.config.ts'), path.join(dir, 'vite.config.mjs'));
    });
    const before = read(cwd, 'vite.config.mjs');
    expect(await run(cwd, DEFAULTS)).toBe('success');
    expect(read(cwd, 'vite.config.mjs')).toBe(before);
    expect(nextSteps(DEFAULTS).join('\n')).toContain('typegen({ config: \'src/lib/i18n.ts\'');
  });
});

describe('writes', () => {
  test('the demo messages in English, marking those of every other language for translating', async () => {
    const cwd = project('messages');
    expect(await run(cwd, { ...DEFAULTS, locales: 'cs,en-GB' })).not.toBeInstanceOf(Array);
    const greeting = (locale: string): string => (JSON.parse(read(cwd, `src/lib/translations/${locale}/common.json`)) as { greeting: string }).greeting;
    expect(greeting('cs')).toMatch(/^\[cs\] /);
    expect(greeting('en-GB')).toMatch(/^Hello/);
  });
});
