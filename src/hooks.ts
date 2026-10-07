import { transforms, type TransformFn } from '@sveltejs/sv-utils';

import { UNPARSED, findExport, freeName, importNamed, reachesI18n, starred, unexport } from './ast.js';
import type { Routing } from './options.js';

type Options = {
  language: 'ts' | 'js';
  routing: Routing;
  /** Records why the file was left alone. */
  skip: (reason: string) => void;
  /** Records the name of the locale stub, once it is written. */
  stub?: (name: string) => void;
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
 * Hooks the i18n `handle` into `hooks.server`: re-exported when the module has
 * none, and otherwise run after the app's own through `sequence()`. With
 * `routing: custom`, a stub that fills `event.locals.lang` runs before it.
 */
export const hooksServer = ({ language, routing, skip, stub: onStub }: Options): TransformFn => transforms.script(({ ast, comments, js }) => {
  if (reachesI18n(ast)) return false;

  const shape = findExport(ast, 'handle');
  if (shape.kind === 'other' || shape.kind === 'star') {
    const why = shape.kind === 'star' ? starred('handle') : 'it exports `handle` in a shape the add-on does not merge into.';
    skip(`${why} Add the i18n \`handle\` from \`#lib/i18n.js\` to it with \`sequence()\` from \`@sveltejs/kit/hooks\`.`);
    return false;
  }

  if (shape.kind === 'none' && routing !== 'custom') {
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
  handles.push(i18n);

  // A module that names something `handle` already, the app's own handle
  // kept under its name included, exports the sequence under another.
  const all = freeName(js, [ast], 'handle') === 'handle' ? undefined : freeName(js, [ast], 'handleAll');
  const code = all
    ? `const ${all} = ${sequence}(${handles.join(', ')});\n\nexport { ${all} as handle };`
    : `export const handle = ${sequence}(${handles.join(', ')});`;
  js.common.appendFromString(ast, { code: stub ? `${localeStub(stub, language)}\n\n${code}` : code, comments });
  if (stub) onStub?.(stub);
}, { onError: () => skip(UNPARSED) });
