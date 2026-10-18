import fs from 'node:fs';
import path from 'node:path';

import { expect as playwrightExpect, type Page } from '@playwright/test';

import own from '../../package.json' with { type: 'json' };
import addon from '../../src/index.js';
import { EXTENSIONS, FORMATS } from '../../src/packages.js';
import { read, script, serve, vendored, write } from '../setup/project.js';
import { setupTest } from '../setup/suite.js';

const id = addon.id;

/** Up to five cases build and serve at once, so a page answers slower than on its own. */
const expectPage = playwrightExpect.configure({ timeout: 15_000 });

type Case = {
  locales: string[];
  format?: 'curly' | 'icu' | 'mf2' | 'i18next' | 'fluent';
  routing?: 'cookie' | 'prefix' | 'custom';
  typegen?: boolean;
  extensions?: ('typed-access' | 'html' | 'markdown' | 'stores')[];
  /** `kit.paths.base`, set before the add-on runs. */
  base?: string;
};

/** What each kind asks for; `defaults` states nothing, so every option takes its default. */
const CASES: Record<string, Case> = {
  defaults: { locales: ['en'] },
  cookie: { locales: ['en', 'cs'] },
  prefix: { locales: ['en', 'cs'], routing: 'prefix' },
  'prefix-base': { locales: ['en', 'cs'], routing: 'prefix', base: '/app' },
  custom: { locales: ['en', 'cs'], routing: 'custom' },
  stores: { locales: ['en', 'cs'], typegen: false, extensions: ['stores'] },
  extensions: { locales: ['en', 'cs'], extensions: ['typed-access', 'html', 'stores'] },
  icu: { locales: ['en', 'cs'], format: 'icu', extensions: ['html'] },
  markdown: { locales: ['en', 'cs'], format: 'icu', extensions: ['markdown', 'stores'] },
  mf2: { locales: ['en', 'cs'], format: 'mf2' },
  i18next: { locales: ['en', 'cs'], format: 'i18next' },
  fluent: { locales: ['en', 'cs'], format: 'fluent', extensions: ['markdown'] },
  rtl: { locales: ['en', 'pt-BR', 'ar'] },
};

const options = (type: string, { locales, format = 'curly', routing = 'cookie', typegen = true, extensions = [] }: Case) => (
  type === 'defaults' ? {} : { locales: locales.join(','), format, routing, typegen, extensions, demo: true }
);

const { test, testCases } = setupTest({ [id]: addon }, {
  kinds: Object.entries(CASES).map(([type, settings]) => ({ type, options: { [id]: options(type, settings) } })),
  filter: ({ variant }) => variant.startsWith('kit'),
  browser: true,
  preAdd: ({ addonTestCase, cwd }) => {
    vendored(cwd);
    const { base } = CASES[addonTestCase.kind.type];
    if (!base) return;
    const file = path.join(cwd, 'vite.config.ts');
    const config = path.join(cwd, fs.existsSync(file) ? 'vite.config.ts' : 'vite.config.js');
    fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('adapter: adapter()', `adapter: adapter(),\n\t\t\tpaths: { base: '${base}' }`));
  },
});

/** The greeting the demo renders in `locale`, as `messages()` writes it. */
const greeting = (locale: string): string => `${locale.split('-')[0] === 'en' ? '' : `[${locale}] `}Hello, World!`;

/** Text as a reader sees it: MessageFormat 2 and Fluent isolate a placeholder with bidi marks. */
const visible = (text: string | null): string => (text ?? '').replace(/[\u2066-\u2069]/g, '');

const heading = async (page: Page): Promise<string> => visible(await page.locator('h1').textContent());

/** What the parser reports for the probe's message, and what `html` and `markdown` report for theirs. */
const REPORTS = { parser: 'modifier this parser does not know', html: 'Tag <blink>', markdown: 'The image in the message' };

/**
 * A message `html` or `markdown` reports, as neither maps the node by
 * default; `markdown`'s also holds an autolink, which ICU reads as a tag, and
 * fails the message over, unless it ignores tags.
 */
const RICH = { html: 'Read <blink>this</blink>.', markdown: 'Read <https://sveltekit-i18n.github.io> and ![this](/x.png).' };

const richOf = (extensions: NonNullable<Case['extensions']>) => extensions.find((id) => id === 'html' || id === 'markdown');

/** The mark a replaced logger puts on what it writes. */
const MARK = '[app logger]';

/**
 * A page of its own that renders a message the Curly Message Format reports,
 * and with `html` or `markdown` one from `RICH`. With `replaceLogger`, the
 * logger of `#lib/i18n` marks what it writes, so the reports are seen to go
 * through it.
 */
const addReportProbe = (cwd: string, ts: boolean, { format = 'curly', extensions = [] }: Case, replaceLogger: boolean): void => {
  const stores = extensions.includes('stores');
  const curly = format === 'curly';
  const rich = richOf(extensions);

  const messages = 'src/lib/translations/en/common.json';
  write(cwd, messages, JSON.stringify({
    ...JSON.parse(read(cwd, messages)) as object,
    ...(curly ? { report: '{{v:shout}}' } : {}),
    ...(rich ? { tagged: RICH[rich] } : {}),
  }, null, '\t'));

  if (replaceLogger) {
    const i18n = `src/lib/i18n.${ts ? 'ts' : 'js'}`;
    const replaced = ts
      ? `const logger = { ...console, warn: (...args: unknown[]) => console.warn('${MARK}', ...args) };`
      : `const logger = { ...console, warn: /** @param {unknown[]} args */ (...args) => console.warn('${MARK}', ...args) };`;
    write(cwd, i18n, read(cwd, i18n).replace('const logger = console;', replaced));
  }

  const read_ = stores ? `const { ${curly ? 't' : ''}${curly && rich ? ', ' : ''}${rich ? 'instance' : ''} } = get();` : 'const i18n = get();';
  const t = stores ? '$t' : 'i18n.t';
  const T = stores ? 'instance.T' : 'i18n.T';
  write(cwd, 'src/routes/report/+page.svelte', `<script${ts ? ' lang="ts"' : ''}>
\timport { get } from '#lib/i18n.js';

\t${read_}
</script>

${curly ? `<p>{${t}('common.report', { v: 'x' })}</p>\n` : ''}${rich ? `<p><${T} key="common.tagged" /></p>\n` : ''}`);
};

/** A page typegen's schema must reject, which svelte-check then fails unless the key is refused. */
const addTypeProbe = (cwd: string): void => write(cwd, 'src/routes/typed/+page.svelte', `<script lang="ts">
\timport { get } from '#lib/i18n.js';

\tconst i18n = get();
\t// @ts-expect-error typegen's schema has no such key.
\tconst missing = i18n.t('common.nope');
</script>

<p>{missing}</p>
`);

test.concurrent.for(testCases)('sveltekit-i18n $kind.type $variant', async (testCase, { page, expect, ...ctx }) => {
  const cwd = ctx.cwd(testCase);
  const type = testCase.kind.type;
  const settings = CASES[type];
  const { locales, format = 'curly', routing = 'cookie', typegen = true, extensions = [], base = '' } = settings;
  const ts = testCase.variant === 'kit-ts';

  // The files and the dependencies.
  for (const locale of locales) expect(fs.existsSync(path.join(cwd, `src/lib/translations/${locale}/common.json`))).toBe(true);
  // Each at the range the add-on's own suite runs against.
  const pkg = JSON.parse(read(cwd, 'package.json')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const ours = (dependencies: Record<string, string> = {}) => Object.fromEntries(Object.entries(dependencies).filter(([name]) => name === 'sveltekit-i18n' || name.startsWith('@sveltekit-i18n/')));
  const installed = [
    ...FORMATS.find(({ id: format_ }) => format_ === format)!.packages,
    ...EXTENSIONS.filter((extension) => extensions.includes(extension.id)).map((extension) => extension.package),
  ];
  expect(ours(pkg.dependencies)).toEqual(Object.fromEntries(installed.map((name) => [name, own.devDependencies[name]])));
  expect(ours(pkg.devDependencies)).toEqual(typegen ? { '@sveltekit-i18n/typegen': own.devDependencies['@sveltekit-i18n/typegen'] } : {});
  if (base) expect(read(cwd, `src/lib/i18n.${ts ? 'ts' : 'js'}`)).toContain(`basePath: '${base}',`);
  expect(read(cwd, 'src/app.html')).toMatch(/<html[^>]* lang="%lang%" dir="%dir%"/);
  if (typegen) expect(read(cwd, '.gitignore')).toContain('src/i18n-schema.d.ts');

  // The defaults report through `console`; the extensions, `html` or `markdown` among them, through a replaced logger.
  const probed = type === 'defaults' || type === 'extensions' || type === 'markdown';
  const marked = type !== 'defaults';
  if (probed) addReportProbe(cwd, ts, settings, marked);
  if (type === 'defaults' && ts) addTypeProbe(cwd);

  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });

  await script(cwd, 'build');
  if (typegen) expect(read(cwd, 'src/i18n-schema.d.ts')).toContain("'common.greeting'");
  await script(cwd, 'check');

  const url = await serve(cwd, page, { expect, onTestFinished: ctx.onTestFinished });

  const origin = new URL(url).origin;
  const at = (pathname: string): string => `${origin}${base}${pathname}`;
  const [first, second] = locales;

  // sv's demo links, in the root layout, reach the page.
  await page.goto(at('/'));
  await page.getByRole('link', { name: 'sveltekit-i18n' }).click();
  await expectPage(page).toHaveURL(at('/demo/sveltekit-i18n'));
  expect(await heading(page)).toBe(greeting(first));
  await expectPage(page.locator('html')).toHaveAttribute('lang', first);

  const rich = richOf(extensions);
  if (rich) {
    await expectPage(page.locator('p a[href="https://sveltekit-i18n.github.io"]')).toHaveText('the documentation');
  }

  if (probed) {
    expect(warnings).toEqual([]);
    await page.goto(at('/report'));
    if (rich === 'markdown') {
      await expectPage(page.locator('p a[href="https://sveltekit-i18n.github.io"]')).toHaveText('https://sveltekit-i18n.github.io');
    }
    const expected = [...(format === 'curly' ? [REPORTS.parser] : []), ...(rich ? [REPORTS[rich]] : [])];
    for (const report of expected) {
      await expectPage.poll(() => warnings.some((text) => text.includes(report) && text.startsWith(MARK) === marked)).toBe(true);
    }
    // Nothing else: a message the parser fails reports that too.
    expect(warnings.filter((text) => !expected.some((report) => text.includes(report)))).toEqual([]);
    if (type === 'defaults') return;
    await page.goto(at('/demo/sveltekit-i18n'));
  }

  if (routing === 'prefix') {
    // The prefixed locale renders on the server, and the switcher's links move between the addresses.
    const response = await page.goto(at(`/${second}/demo/sveltekit-i18n`));
    const html = await response!.text();
    expect(html).toContain(`lang="${second}"`);
    expect(visible(html)).toContain(greeting(second));
    await expectPage(page.getByRole('link', { name: `[${second}] Home`, exact: true })).toHaveAttribute('href', `${base}/${second}`);

    await page.getByRole('link', { name: first, exact: true }).click();
    await expectPage(page).toHaveURL(at('/demo/sveltekit-i18n'));
    expect(await heading(page)).toBe(greeting(first));
    await expectPage(page.locator('html')).toHaveAttribute('lang', first);

    await page.getByRole('link', { name: second, exact: true }).click();
    await expectPage(page).toHaveURL(at(`/${second}/demo/sveltekit-i18n`));
    await expectPage.poll(() => heading(page)).toBe(greeting(second));
    return;
  }

  // The switcher changes the locale in place, once the page has hydrated: a click before that does nothing.
  const target = locales.at(-1)!;
  await expectPage(async () => {
    await page.getByRole('button', { name: target, exact: true }).click();
    expect(await heading(page)).toBe(greeting(target));
  }).toPass({ timeout: 15_000 });
  await expectPage(page.locator('html')).toHaveAttribute('lang', target);
  if (target === 'ar') await expectPage(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // The cookie carries the choice to the next request; the custom stub keeps none.
  const response = await page.reload();
  const html = await response!.text();
  const rendered = routing === 'cookie' ? target : first;
  expect(html).toContain(`lang="${rendered}"`);
  expect(visible(html)).toContain(greeting(rendered));
  if (rendered === 'ar') expect(html).toContain('dir="rtl"');
});
