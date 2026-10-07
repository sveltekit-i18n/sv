import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { readBase } from '../../src/base.js';
import addon from '../../src/index.js';
import { parseLocales } from '../../src/locales.js';
import { readOptions } from '../../src/options.js';
import { TEST_DIR } from '../setup/global.js';

const defaults = { locales: 'en', format: 'curly', routing: 'cookie', typegen: true, extensions: [], demo: true };

describe('options', () => {
  test('locales are spelled as the core keys them', () => {
    expect(parseLocales('en, pt-br ,ar,en')).toEqual({ locales: ['en', 'pt-BR', 'ar'], invalid: [] });
    expect(parseLocales('en,en_US')).toEqual({ locales: [], invalid: ['en_US'] });
    expect(parseLocales(' , ')).toEqual({ locales: [], invalid: [] });
  });

  test('every option is read again, as the command line skips validate', () => {
    expect(readOptions(defaults)).toMatchObject({ locales: ['en'], routing: 'cookie', extensions: [] });
    expect(readOptions({ ...defaults, locales: 'en_US' })).toContain('Not a locale: en_US');
    expect(readOptions({ ...defaults, locales: '' })).toContain('at least one locale');
    expect(readOptions({ ...defaults, format: 'fluent' })).toContain('Unknown format');
    expect(readOptions({ ...defaults, routing: 'header' })).toContain('Unknown routing');
    expect(readOptions({ ...defaults, typegen: 'yes' })).toContain('`typegen`');
    expect(readOptions({ ...defaults, demo: undefined })).toContain('`demo`');
    expect(readOptions({ ...defaults, extensions: 'stores' })).toContain('takes a list');
    expect(readOptions({ ...defaults, extensions: ['markdown'] })).toContain('Unknown extension markdown');
  });

  test('extensions land in the order the pipe needs, whatever order they were named in', () => {
    const settings = readOptions({ ...defaults, extensions: ['stores', 'html', 'typed-access'] });
    expect(typeof settings !== 'string' && settings.extensions.map(({ id }) => id)).toEqual(['typed-access', 'html', 'stores']);
  });
});

describe('setup', () => {
  const setup = (isKit: boolean, kit: string | undefined) => {
    const reasons: string[] = [];
    void addon.setup?.({
      isKit,
      dependencyVersion: (name: string) => (name === '@sveltejs/kit' ? kit : undefined),
      unsupported: (reason: string) => reasons.push(reason),
    } as unknown as Parameters<NonNullable<typeof addon.setup>>[0]);
    return reasons;
  };

  test('refuses a project without SvelteKit, or on SvelteKit 2', () => {
    expect(setup(false, undefined)).toEqual(['Requires SvelteKit']);
    expect(setup(true, '^2.20.0')).toEqual(['Requires SvelteKit 3 or newer']);
    expect(setup(true, '^3.0.0')).toEqual([]);
  });
});

describe('kit.paths.base', () => {
  const read = (config: string | undefined, file = 'svelte.config.js') => {
    const cwd = path.join(TEST_DIR, 'unit-base', String(Math.abs(hash(`${file}:${config ?? ''}`))));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd, { recursive: true });
    if (config !== undefined) fs.writeFileSync(path.join(cwd, file), config);
    return readBase(cwd);
  };

  test('is read where it is a literal', () => {
    expect(read(undefined)).toEqual({ known: true, value: '' });
    expect(read('export default { kit: {} };\n')).toEqual({ known: true, value: '' });
    expect(read("export default { kit: { paths: { base: '/app' } } };\n")).toEqual({ known: true, value: '/app' });
    expect(read('export default { kit: { paths: { base: `/docs` } } };\n')).toEqual({ known: true, value: '/docs' });
    expect(read("const config = { kit: { paths: { assets: '', base: '' } } };\nexport default config;\n")).toEqual({ known: true, value: '' });
    // Kit 3's own shape: the options of `sveltekit()` in the Vite config.
    const vite = (paths: string) => `import { sveltekit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [sveltekit({ ${paths} })] });\n`;
    expect(read(vite(''), 'vite.config.ts')).toEqual({ known: true, value: '' });
    expect(read(vite("paths: { base: '/app' }"), 'vite.config.ts')).toEqual({ known: true, value: '/app' });
    expect(read(vite('paths: { base: process.env.BASE }'), 'vite.config.ts')).toEqual({ known: false });
  });

  test('is unknown wherever running the config would decide it', () => {
    expect(read('export default { kit: { paths: { base: process.env.BASE_PATH } } };\n')).toEqual({ known: false });
    expect(read('const paths = { base: \'/x\' };\nexport default { kit: { paths } };\n')).toEqual({ known: false });
    expect(read('const shared = {};\nexport default { kit: { paths: { ...shared } } };\n')).toEqual({ known: false });
    expect(read('export default { kit: { paths: { base: `/${1}` } } };\n')).toEqual({ known: false });
    expect(read("const kit = { paths: { base: '/x' } };\nexport default { kit };\n")).toEqual({ known: false });
    const vite = (options: string) => `import { sveltekit as kit } from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\n${options}\n`;
    expect(read(vite("const options = { paths: { base: '/app' } };\nexport default defineConfig({ plugins: [kit(options)] });"), 'vite.config.ts')).toEqual({ known: false });
    expect(read(vite("const options = { paths: { base: '/app' } };\nexport default defineConfig({ plugins: [kit({ ...options })] });"), 'vite.config.ts')).toEqual({ known: false });
    expect(read(vite("export default defineConfig({ plugins: [kit({ paths: { base: '/app' } } as const)] });"), 'vite.config.ts')).toEqual({ known: false });
    const namespace = "import * as kit from '@sveltejs/kit/vite';\nimport { defineConfig } from 'vite';\n\nexport default defineConfig({ plugins: [kit.sveltekit({ paths: { base: '/app' } })] });\n";
    expect(read(namespace, 'vite.config.ts')).toEqual({ known: false });
    // A Vite config sv-utils does not read.
    expect(read("import { sveltekit } from '@sveltejs/kit/vite';\n\nexport default { plugins: [sveltekit({ paths: { base: '/app' } })] };\n", 'vite.config.mts')).toEqual({ known: false });
  });
});

/** A directory name per config, so the cases never share one. */
function hash(text: string): number {
  let value = 0;
  for (const char of text) value = (Math.imul(31, value) + char.charCodeAt(0)) | 0;
  return value;
}
