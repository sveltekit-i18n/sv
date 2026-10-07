import type { Settings } from './options.js';

type Language = 'ts' | 'js';

const tab = (text: string, depth = 1): string => text.split('\n').map((line) => (line ? `${'\t'.repeat(depth)}${line}` : line)).join('\n');

const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const list = (values: string[]): string => `[${values.map(quote).join(', ')}]`;

/** The parser's options: `extension-html` needs ICU to read tags as text. */
const parserOptions = ({ format, extensions }: Settings): string => (
  format.id === 'icu' && extensions.some(({ id }) => id === 'html') ? '{ onReport, ignoreTag: true }' : '{ onReport }'
);

/** What typegen's `extractParams` gets: the parser's package, and the parser's options where they change what a message names. */
export const extractParams = (settings: Settings): string => {
  const options = settings.format.id === 'icu' && settings.extensions.some(({ id }) => id === 'html') ? ', options: { ignoreTag: true }' : '';
  return `{ from: ${quote(settings.format.from)}${options} }`;
};

/** A locale to name in a comment's example path. */
const example = (locales: string[]): string => locales[1] ?? 'de';

const preferredLocale = ({ routing, locales }: Settings): string => {
  if (routing === 'prefix') {
    return `// The locale is in the path: \`/about\` is the default locale's, \`/${example(locales)}/about\`
// another's. The path, not \`params\`: a root error page matched no route.
preferredLocale: (event) => localeOf(event.url.pathname),`;
  }
  if (routing === 'custom') {
    return `// What \`handle\` in \`hooks.server\` put in \`event.locals\`. A root error page
// rendered in the browser without the server's data has no \`locals\`.
preferredLocale: (event) => event.locals?.lang,`;
  }
  return `// The locale the visitor chose before, which the demo's switcher keeps in
// this cookie. \`Accept-Language\` decides when there is none.
preferredLocale: (event) => event.cookies?.get('lang'),`;
};

/** `$lib/i18n`: the config typegen reads, and the wiring `/kit` builds from it. */
export const i18nModule = (settings: Settings, language: Language, basePath: string | undefined): string => {
  const { format, extensions, locales, routing } = settings;
  const ts = language === 'ts';

  const imports = [
    ...(ts && !format.parser ? [`import type { Config } from ${quote(format.from)};`] : []),
    `import { defineI18n } from ${quote(format.kit)};`,
    ...(format.parser ? [`import parser${ts ? ', { type Config }' : ''} from ${quote(format.from)};`] : []),
    ...extensions.map((extension) => `import ${extension.importName} from ${quote(extension.package)};`),
    ...(routing === 'prefix' ? ['', "import { localeOf } from '#lib/locale.js';"] : []),
  ];

  const config = [
    `initLocale: ${quote(locales[0])},`,
    ...(basePath ? [`// \`kit.paths.base\`, which every route the core matches starts with.\nbasePath: ${quote(basePath)},`] : []),
    'log: { logger },',
    format.parser ? `parser: parser(${parserOptions(settings)}),` : 'parserOptions: { onReport },',
    'loaders: [',
    tab(`{
\tlocale: ${list(locales)},
\tnamespace: 'common',
\tloader: async ({ locale, namespace }) => (await import(\`./translations/\${locale}/\${namespace}.json\`)).default,
},`),
    '],',
  ];

  const input = extensions.length
    ? `{ ...config, extensions: [${extensions.map(({ expression }) => expression).join(', ')}] }`
    : 'config';

  return `${imports.join('\n')}

// Where the core's logs and every report go. Replace it to route them all
// elsewhere; \`log.level\` and \`log.prefix\` apply to the core's logs only.
const logger = console;
${ts ? '' : '/** @param {{ message: string }} report */\n'}const onReport = (report${ts ? ': { message: string }' : ''}) => logger.warn(report.message, report);

${ts ? '' : `/** @satisfies {import(${quote(format.from)}).Config} */\n`}export const config = {
${tab(config.join('\n'))}
}${ts ? ' as const satisfies Config' : ''};

export const { handle, load, use, get } = defineI18n(${input}, {
${tab(preferredLocale(settings))}
});
`;
};

/** `$lib/locale`, as `examples/locale-router-advanced` has it, with `kit.paths.base` stripped where there is one. */
export const localeModule = (locales: string[], language: Language, basePath: string | undefined): string => {
  const ts = language === 'ts';
  const t = (type: string): string => (ts ? `: ${type}` : '');
  const doc = (lines: string[]): string => (ts ? '' : `/**\n${lines.map((line) => ` * ${line}`).join('\n')}\n */\n`);

  const base = basePath
    ? `
/** \`kit.paths.base\`, which every pathname the app reads starts with. */
const BASE = ${quote(basePath)};

${doc(['@param {string} pathname'])}const withoutBase = (pathname${t('string')})${t('string')} =>
\tpathname === BASE || pathname.startsWith(\`\${BASE}/\`) ? pathname.slice(BASE.length) || '/' : pathname;
`
    : '';
  const path = basePath ? 'withoutBase(pathname)' : 'pathname';
  const find = (subject: string): string => `PREFIXED.find((locale) => ${subject} === \`/\${locale}\` || ${subject}.startsWith(\`/\${locale}/\`)) ?? DEFAULT_LOCALE`;
  const localeOf = basePath
    ? `{\n\tconst path = ${path};\n\treturn ${find('path')};\n}`
    : `\n\t${find('pathname')}`;

  return `export const DEFAULT_LOCALE = ${quote(locales[0])};

export const LOCALES = ${ts ? `${list(locales)} as const` : `/** @type {const} */ (${list(locales)})`};

${ts ? 'export type Locale = (typeof LOCALES)[number];' : '/** @typedef {(typeof LOCALES)[number]} Locale */'}

/** The locales that appear in the URL. The default one deliberately does not. */
export const PREFIXED = LOCALES.filter((locale) => locale !== DEFAULT_LOCALE);

${doc(['@param {string} value', '@returns {value is Locale}'])}export const isPrefixed = (value${t('string')})${t('value is Locale')} =>
\t${ts ? '(PREFIXED as readonly string[])' : '/** @type {readonly string[]} */ (PREFIXED)'}.includes(value);

${doc(['@param {string} locale'])}export const prefixOf = (locale${t('string')})${t('string')} => (locale === DEFAULT_LOCALE ? '' : \`/\${locale}\`);
${base}
${doc(['@param {string} pathname', '@returns {Locale}'])}export const localeOf = (pathname${t('string')})${t('Locale')} =>${basePath ? ' ' : ''}${localeOf};

${ts ? '/** The path without its locale prefix, which a link puts under another locale. */\n' : ''}${doc(['The path without its locale prefix, which a link puts under another locale.', '@param {string} pathname', '@param {string} locale'])}export const routeOf = (pathname${t('string')}, locale${t('string')})${t('string')} =>
\t${path}.replace(prefixOf(locale), '') || '/';

${ts ? `/** \`route\` under \`locale\`'s prefix: \`/${example(locales)}/about\`, and \`/about\` in the default locale. */\n` : ''}${doc([`\`route\` under \`locale\`'s prefix: \`/${example(locales)}/about\`, and \`/about\` in the default locale.`, '@param {string} route', '@param {string} locale'])}export const pathOf = (route${t('string')}, locale${t('string')})${t('string')} =>
\t\`\${prefixOf(locale)}\${route === '/' ? '' : route}\` || '/';
`;
};

/**
 * The `params` file, importing the locale helpers from `from`: with their own
 * extension, since Kit's build imports `params` with Node itself, which maps
 * no `.js` to the `.ts` beside it.
 */
export const paramsModule = (from: string): string => `import { defineParams } from '@sveltejs/kit/params';

${from.endsWith('.ts') ? `// \`.ts\`, not \`.js\`: the build imports this file with Node itself, which maps
// no \`.js\` to the \`.ts\` beside it.
` : ''}import { isPrefixed } from '${from}';

export const params = defineParams({
\t// Only the prefixed locales match. The default locale has no segment at all,
\t// so accepting it here would give every page two addresses, and accepting
\t// anything would let the optional segment swallow \`/about\`.
\tlocale: (param) => (isPrefixed(param) ? param : undefined),
});
`;

/** The demo's messages, in English: marked for translating in a locale of any other language. */
export const messages = (settings: Settings, locale: string): Record<string, string> => {
  const mark = locale.split('-')[0] === 'en' ? '' : `[${locale}] `;
  return {
    greeting: `${mark}${settings.format.greeting('Hello')}`,
    'nav.home': `${mark}Home`,
    ...(settings.extensions.some(({ id }) => id === 'html')
      ? { docs: `${mark}Read <a href="https://sveltekit-i18n.github.io">the documentation</a>.` }
      : {}),
  };
};

export const json = (data: Record<string, string>): string => `${JSON.stringify(data, null, '\t')}\n`;

/** The demo page: a translated greeting and a language switcher, read the way the selected extensions hand the instance out. */
export const demoPage = (settings: Settings, language: Language): string => {
  const ts = language === 'ts';
  const { routing, extensions } = settings;
  const stores = extensions.some(({ demo }) => demo === 'stores');
  const html = extensions.some(({ demo }) => demo === 'component');

  const imports = [
    ...(routing === 'prefix' ? ["import { resolve } from '$app/paths';", "import { page } from '$app/state';"] : ["import { resolve } from '$app/paths';"]),
    ...(routing === 'prefix' && ts ? ["import type { Path } from '$app/types';"] : []),
    '',
    "import { get } from '#lib/i18n.js';",
    ...(routing === 'prefix' ? ["import { LOCALES, localeOf, pathOf, routeOf } from '#lib/locale.js';"] : []),
  ];

  const t = stores ? '$t' : 'i18n.t';
  // Only what the page reads: a linter rejects an unused binding.
  const members = ['t', ...(routing === 'prefix' ? [] : ['locale', 'locales']), ...(html ? ['instance'] : [])];
  const read = stores ? `const { ${members.join(', ')} } = get();` : 'const i18n = get();';

  let script: string;
  let switcher: string;
  let home: string;

  if (routing === 'prefix') {
    const path = (expression: string): string => (ts ? `${expression} as Path` : `/** @type {import('$app/types').Path} */ (${expression})`);
    script = `${read}

const current = $derived(localeOf(page.url.pathname));
const route = $derived(routeOf(page.url.pathname, current));`;
    switcher = `{#each LOCALES as target (target)}
\t<a href={resolve(${path('pathOf(route, target)')})} aria-current={target === current ? 'page' : undefined}>{target}</a>
{/each}`;
    home = `resolve(${path("pathOf('/', current)")})`;
  } else {
    const set = stores ? 'locale.set(target)' : 'i18n.locale = target';
    const persist = routing === 'cookie'
      ? `// Kept in the \`lang\` cookie, which \`preferredLocale\` in \`#lib/i18n\` reads on
// the next request; the page switches right away.
${ts ? 'const choose = (target: string) => {' : '/** @param {string} target */\nconst choose = (target) => {'}
\tdocument.cookie = \`lang=\${target}; path=/; max-age=31536000; samesite=lax\`;
\t${set};
};`
      : `// Switches this tab only. Keep the choice where \`handle\` in \`hooks.server\`
// reads it (the user's profile), so the next request gets it too.
${ts ? 'const choose = (target: string) => {' : '/** @param {string} target */\nconst choose = (target) => {'}
\t${set};
};`;
    script = `${read}

${persist}`;
    const each = stores ? '$locales' : 'i18n.locales';
    const active = stores ? '$locale' : 'i18n.locale';
    switcher = `{#each ${each} as target (target)}
\t<button onclick={() => choose(target)} aria-pressed={target === ${active}}>{target}</button>
{/each}`;
    home = "resolve('/')";
  }

  const component = stores ? 'instance.T' : 'i18n.T';

  return `<script${ts ? ' lang="ts"' : ''}>
${tab(imports.join('\n'))}

${tab(script)}
</script>

<h1>{${t}('common.greeting', { name: 'World' })}</h1>
${html ? `\n<p><${component} key="common.docs" /></p>\n` : ''}
<nav>
${tab(switcher)}
</nav>

<p><a href={${home}}>{${t}('common.nav.home')}</a></p>
`;
};
