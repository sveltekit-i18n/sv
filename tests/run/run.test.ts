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
  });

  test('an i18n module of another setup', async () => {
    const [reason] = await cancels(project('i18n', (dir) => edit(dir, 'src/lib/i18n.ts', () => 'export const t = (key: string) => key;\n')));
    expect(reason).toContain('src/lib/i18n.ts');
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

  test('prefix routing links through resolve(), and needs a Node that strips types on Node only', () => {
    const steps = nextSteps({ ...DEFAULTS, routing: 'prefix' }).join('\n');
    expect(steps).toContain('resolve(pathOf(');
    expect(steps).toContain('On Node, ');
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
