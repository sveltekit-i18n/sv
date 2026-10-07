import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, inject, test } from 'vitest';

import { fromTemplate, read, tree } from '../setup/project.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SV = path.join(ROOT, 'node_modules/sv/dist/bin.mjs');

/** `sv add` over the built package, as `npx sv add @sveltekit-i18n` runs it, with every option given as text. */
const add = (cwd: string, options: string): { status: number | null; output: string } => {
  const { status, stdout, stderr } = spawnSync(process.execPath, [
    SV, 'add', `file:${ROOT}=${options}`,
    '--cwd', cwd, '--no-git-check', '--no-install', '--no-download-check',
  ], { encoding: 'utf8', env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  return { status, output: `${stdout}${stderr}` };
};

test('the bundle carries no field of package.json but its devDependencies', () => {
  const bundle = fs.readFileSync(path.join(ROOT, 'dist/index.js'), 'utf8');
  const { description, scripts, repository } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { description: string; scripts: Record<string, string>; repository: { url: string } };

  for (const [field, value] of Object.entries({ description, scripts: scripts.prepublishOnly, repository: repository.url })) {
    expect(value, field).toBeTypeOf('string');
    // `includes`, as a failing `toContain` prints the whole bundle.
    expect(bundle.includes(value), field).toBe(false);
  }
});

test('the command line runs the built add-on with text options, and a second run changes nothing', () => {
  expect(fs.existsSync(path.join(ROOT, 'dist/index.js'))).toBe(true);
  const cwd = fromTemplate(path.join(inject('testDir'), 'cli', 'kit-js'), 'kit-js');

  const options = 'locales:en,cs+format:icu+routing:prefix+typegen:yes+extensions:typed-access,html,stores+demo:yes';
  const first = add(cwd, options);
  expect(first.status, first.output).toBe(0);
  expect(first.output).toContain('[[lang=locale]]');

  const pkg = JSON.parse(read(cwd, 'package.json')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  expect(Object.keys(pkg.dependencies)).toEqual([
    '@sveltekit-i18n/base',
    '@sveltekit-i18n/extension-html',
    '@sveltekit-i18n/extension-stores',
    '@sveltekit-i18n/extension-typed-access',
    '@sveltekit-i18n/parser-icu',
  ]);
  const { devDependencies } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };
  for (const [name, range] of Object.entries(pkg.dependencies)) expect(range, name).toBe(devDependencies[name]);
  expect(pkg.devDependencies['@sveltekit-i18n/typegen']).toBe(devDependencies['@sveltekit-i18n/typegen']);

  const i18n = read(cwd, 'src/lib/i18n.js');
  expect(i18n).toContain("initLocale: 'en',");
  expect(i18n).toContain('parser: parser({ onReport, ignoreTag: true }),');
  expect(i18n).toContain('extensions: [typedAccess, html({ onReport }), stores]');
  expect(fs.existsSync(path.join(cwd, 'src/lib/locale.js'))).toBe(true);
  expect(fs.existsSync(path.join(cwd, 'src/routes/[[lang=locale]]/demo/sveltekit-i18n/+page.svelte'))).toBe(true);

  const before = tree(cwd);
  const again = add(cwd, options);
  expect(again.output).toContain('depends on `@sveltekit-i18n/base` already');
  expect(tree(cwd)).toEqual(before);
});
