import { transforms, type TransformFn } from '@sveltejs/sv-utils';

import { UNPARSED, findExport, freeName, importNamed, isI18nModule, reachesI18n, starred, unexport, type Js, type Program } from './ast.js';
import type { Routing } from './options.js';

type Options = {
  language: 'ts' | 'js';
  routing: Routing;
  /** Records why the file was left alone. */
  skip: (reason: string) => void;
  /** Records the name of the locale stub, once it is written. */
  stub?: (name: string) => void;
  /** `kit.paths.base`, which the redirect of `routing: translated` strips and adds back. */
  basePath?: string;
};

const handleType = "import('@sveltejs/kit/hooks').Handle";

/** The `handle` that puts the app's own source of the locale into `event.locals`. */
const localeStub = (name: string, language: 'ts' | 'js'): string => `
// Where the app's own source of the locale goes: load the user's preference
// (from a session or a database) into \`event.locals.lang\`, which
// \`preferredLocale\` in \`#lib/i18n\` reads.
${language === 'ts' ? `const ${name}: ${handleType}` : `/** @type {${handleType}} */\nconst ${name}`} = async ({ event, resolve }) => {
\t// event.locals.lang = (await db.getUser(event.locals.userId))?.locale;
\treturn resolve(event);
};`;

/**
 * The `handle` that redirects a pathname the catch-all of `pathnames` gives a
 * page to the page's own pathname in that locale, as the core's docs have it.
 */
const localizeHandle = (name: string, ast: Program, js: Js, language: 'ts' | 'js', basePath: string | undefined): string => {
  const delocalize = importNamed(ast, js, 'delocalize', '#lib/i18n.js');
  const localizePath = importNamed(ast, js, 'localizePath', '#lib/i18n.js');
  const redirect = importNamed(ast, js, 'redirect', '@sveltejs/kit');
  const base = basePath ? `${importNamed(ast, js, 'config', '#lib/i18n.js', 'i18nConfig')}.basePath` : undefined;
  const pathname = base ? 'pathname' : 'event.url.pathname';
  return `
// Once a page has a pathname of its own in \`pathnames\` of \`#lib/i18n\`, sends
// the one the catch-all gave it there. A remote function's request carries the
// URL of the page that called it, so it is left alone.
${language === 'ts' ? `const ${name}: ${handleType}` : `/** @type {${handleType}} */\nconst ${name}`} = ({ event, resolve }) => {
\tconst { path, locale } = ${delocalize}(event.url);

\tif (locale !== undefined && !event.isRemoteRequest) {
\t\t// SvelteKit drops a trailing slash before \`handle\` only from a pathname a
\t\t// route matches, so the target leaves it out, as the default
\t\t// \`trailingSlash: 'never'\` serves it, and the pathnames compare without it.
\t\tconst href = ${localizePath}(path.replace(/^([^?#]+?)\\/(?=[?#]|$)/, '$1'), locale);
${base ? `\t\tconst pathname = event.url.pathname.slice(${base}.length) || '/';\n` : ''}
\t\tif (href.replace(/[?#].*/s, '').replace(/\\/$/, '') !== ${pathname}.replace(/\\/$/, '')) {
\t\t\t${redirect}(308, ${base ? `\`\${${base}}\${href}\`` : 'href'});
\t\t}
\t}

\treturn resolve(event);
};`;
};

/**
 * Hooks the i18n `handle` into `hooks.server`: re-exported when the module has
 * none, and otherwise run after the app's own through `sequence()`. With
 * `routing: custom`, a stub that fills `event.locals.lang` runs before it;
 * with `routing: translated`, the redirect to a page's own pathname.
 */
export const hooksServer = ({ language, routing, skip, stub: onStub, basePath }: Options): TransformFn => transforms.script(({ ast, comments, js }) => {
  if (reachesI18n(ast)) return false;

  const shape = findExport(ast, 'handle');
  if (shape.kind === 'other' || shape.kind === 'star') {
    const why = shape.kind === 'star' ? starred('handle') : 'it exports `handle` in a shape the add-on does not merge into.';
    skip(`${why} Add the i18n \`handle\` from \`#lib/i18n.js\` to it with \`sequence()\` from \`@sveltejs/kit/hooks\`.`);
    return false;
  }

  if (shape.kind === 'none' && routing !== 'custom' && routing !== 'translated') {
    js.common.appendFromString(ast, { code: "export { handle } from '#lib/i18n.js';", comments });
    return;
  }

  const handles: string[] = [];
  if (shape.kind !== 'none') {
    handles.push(unexport(ast, js, shape, 'handle', freeName(js, [ast], 'originalHandle'), false));
  }
  const i18n = importNamed(ast, js, 'handle', '#lib/i18n.js', 'i18nHandle');
  const sequence = importNamed(ast, js, 'sequence', '@sveltejs/kit/hooks');

  const stub = routing === 'custom' ? freeName(js, [ast], 'handleLocale') : undefined;
  if (stub) handles.push(stub);
  const localize = routing === 'translated' ? freeName(js, [ast], 'localize') : undefined;
  const redirect = localize && localizeHandle(localize, ast, js, language, basePath);
  if (localize) handles.push(localize);
  handles.push(i18n);

  // A module that names something `handle` already, the app's own handle
  // kept under its name included, exports the sequence under another.
  const all = freeName(js, [ast], 'handle') === 'handle' ? undefined : freeName(js, [ast], 'handleAll');
  const code = all
    ? `const ${all} = ${sequence}(${handles.join(', ')});\n\nexport { ${all} as handle };`
    : `export const handle = ${sequence}(${handles.join(', ')});`;
  const added = stub ? localeStub(stub, language) : redirect;
  js.common.appendFromString(ast, { code: added ? `${added}\n\n${code}` : code, comments });
  if (stub) onStub?.(stub);
}, { onError: () => skip(UNPARSED) });

/**
 * Re-exports the i18n `reroute` from the universal hooks, which serves each
 * translated pathname from the route of its canonical one.
 */
export const hooksUniversal = ({ skip }: Pick<Options, 'skip'>): TransformFn => transforms.script(({ ast, comments, js }) => {
  const shape = findExport(ast, 'reroute');
  if (shape.kind === 'reexport' && isI18nModule(shape.source)) return false;
  if (shape.kind !== 'none') {
    const why = shape.kind === 'star' ? starred('reroute') : 'it exports a `reroute` of its own.';
    skip(`${why} Return what the i18n \`reroute\` from \`#lib/i18n.js\` gives a pathname from it, or no translated pathname reaches a route.`);
    return false;
  }
  js.common.appendFromString(ast, {
    code: "// Serves each translated pathname from the route of its canonical one.\nexport { reroute } from '#lib/i18n.js';",
    comments,
  });
}, { onError: () => skip(UNPARSED) });
