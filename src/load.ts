import { Walker, transforms, type AstTypes, type Comments, type TransformFn } from '@sveltejs/sv-utils';

import { UNPARSED, findExport, freeName, importNamed, importTypes, moduleBindings, reachesI18n, starred, unexport, type Js, type Program } from './ast.js';

type Options = {
  language: 'ts' | 'js';
  /** `+layout.server` or `+layout`. */
  server: boolean;
  skip: (reason: string) => void;
};

/**
 * Turns the app's own `load`, once it is no longer the export, into a `const`
 * typed by what it returns: Kit infers a layout's data from the exported
 * `load` alone, and an annotation on the renamed one would drop every field
 * it returns from the pages' `data`. Its annotation, or `type`, moves to a
 * `satisfies`, which still types the argument. Returns whether it takes one,
 * as a call with an argument it does not declare no longer type-checks.
 */
const inferReturn = (ast: Program, comments: Comments, exported: AstTypes.ExportNamedDeclaration, language: 'ts' | 'js', type: string): boolean => {
  const declaration = exported.declaration!;
  let variable: AstTypes.VariableDeclaration;
  if (declaration.type === 'FunctionDeclaration') {
    const expression: AstTypes.FunctionExpression = { ...declaration, type: 'FunctionExpression', id: null };
    // At the function's position, so the comments before it stay there.
    const { start, end, loc } = declaration as { start?: number; end?: number; loc?: AstTypes.SourceLocation };
    variable = { type: 'VariableDeclaration', kind: 'const', declarations: [{ type: 'VariableDeclarator', id: declaration.id, init: expression }], loc, ...{ start, end } };
    ast.body.splice(ast.body.indexOf(declaration), 1, variable);
  } else if (declaration.type === 'VariableDeclaration') {
    variable = declaration;
  } else {
    return true;
  }
  const [declarator] = variable.declarations;
  const { init } = declarator;
  // A function that satisfies a type already keeps it, and says what it takes.
  const satisfied = init?.type === 'TSSatisfiesExpression' ? init.expression : undefined;
  if (satisfied?.type === 'ArrowFunctionExpression' || satisfied?.type === 'FunctionExpression') return satisfied.params.length > 0;
  // Anything but a function keeps its type, which then says what it takes.
  if (declarator.id.type !== 'Identifier' || (init?.type !== 'ArrowFunctionExpression' && init?.type !== 'FunctionExpression')) return true;
  const takesEvent = init.params.length > 0;

  if (language === 'ts') {
    const annotation = declarator.id.typeAnnotation?.typeAnnotation;
    delete declarator.id.typeAnnotation;
    declarator.init = {
      type: 'TSSatisfiesExpression',
      expression: init,
      typeAnnotation: annotation ?? { type: 'TSTypeReference', typeName: { type: 'Identifier', name: type } },
    };
    return takesEvent;
  }

  // The parsed comment is the one printed; `leadingComments` holds a copy.
  const jsdoc = lastJsdoc(exported);
  const parsed = jsdoc && comments.list().find((comment) => comment.start === jsdoc.start && comment.end === jsdoc.end);
  const satisfies = `@satisfies {import('./$types').${type}}`;
  if (parsed && soleTag('satisfies').test(parsed.value)) return takesEvent;
  if (parsed && soleTag('type').test(parsed.value)) parsed.value = parsed.value.replace('@type', '@satisfies');
  // TypeScript reads the last JSDoc of a declaration alone: a comment of its own, printed after the one it has.
  else if (parsed) parsed.value = `${parsed.value}*/${parsed.loc?.end.line === exported.loc?.start.line ? ' ' : '\n'}/** ${satisfies} `;
  // A JSDoc of one line would print on the line of the declaration.
  else comments.add(variable, { type: 'Block', value: `*\n * ${satisfies}\n ` });
  return takesEvent;
};

/**
 * A JSDoc whose one tag is `@tag {…}`, where TypeScript always starts a tag:
 * right after `/**`, or at the start of a line after at most one `*`.
 */
const soleTag = (tag: 'type' | 'satisfies'): RegExp => new RegExp(String.raw`^\*(?:[^@]*?[\r\n][ \t]*(?:\*[ \t]*)?|[ \t]*)@${tag}[ \t]*\{[^@]*$`);

/** The last JSDoc before the export, which the parser attached to it. */
const lastJsdoc = (exported: AstTypes.ExportNamedDeclaration): AstTypes.Comment | undefined => (
  (exported as { leadingComments?: AstTypes.Comment[] }).leadingComments
    ?.filter((comment) => comment.type === 'Block' && comment.value.startsWith('*'))
    .at(-1)
);

/** The tags TypeScript reads off the last JSDoc of a function alone, which a `@satisfies` after it would hide. */
const FUNCTION_TAGS = /@(?:returns?|param|arg|argument|template|this)\b/;

/**
 * Why the JSDoc of a JavaScript `load` that is a function keeps the add-on
 * from typing it, if it does: one between `export` and the function, which
 * would type `ownLoad` too, or tags of the function, which its own
 * `@satisfies` would hide.
 */
const untypable = (comments: Comments, exported: AstTypes.ExportNamedDeclaration, type: string): string | undefined => {
  const { declaration } = exported;
  const init = declaration?.type === 'VariableDeclaration' ? declaration.declarations[0].init : undefined;
  const end = declaration?.type === 'FunctionDeclaration' ? declaration.id?.end
    : init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression' ? init.start : undefined;
  const start = (exported as { start?: number }).start;
  if (end === undefined || start === undefined) return undefined;
  if (comments.list().some((comment) => comment.type === 'Block' && comment.value.startsWith('*') && comment.start > start && comment.start < end)) {
    return 'it types `load` with a JSDoc inside its declaration. Move the comment above `export`, then run the add-on again.';
  }
  const jsdoc = lastJsdoc(exported)?.value;
  if (jsdoc && !soleTag('type').test(jsdoc) && !soleTag('satisfies').test(jsdoc) && FUNCTION_TAGS.test(jsdoc)) {
    return `it types \`load\` with \`@param\`, \`@returns\`, \`@template\` or \`@this\`. Type it with \`@type {import('./$types').${type}}\` alone instead, then run the add-on again.`;
  }
  return undefined;
};

/** Wrappers of an expression that type it, whose expression is evaluated. */
const TYPED_EXPRESSIONS = ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'];

/**
 * Whether `nodes` read `name` as the module is evaluated, outside a function
 * and a type: a binding the new export declares at the end of the module is
 * not initialized yet there.
 */
const readOnEvaluation = (js: Js, nodes: AstTypes.Node[], name: string): boolean => {
  let found = false;
  for (const root of nodes) {
    Walker.walk<AstTypes.Node, null>(root, null, {
      _(node, { next, path }) {
        if (found || ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
        if (node.type.startsWith('TS') && !TYPED_EXPRESSIONS.includes(node.type)) return;
        const parent = path.at(-1);
        if (node.type === 'Identifier' && node.name === name && parent?.type !== 'ExportSpecifier' && js.identifiers.isReference(node, parent)) {
          found = true;
          return;
        }
        next();
      },
    });
  }
  return found;
};

/**
 * Gives the root layout the i18n `load`: assigned rather than re-exported,
 * since Kit's static analysis gives up on a `load` exported from another
 * module. An existing `load` is kept, and called beside it.
 */
export const layoutLoad = ({ language, server, skip }: Options): TransformFn => transforms.script(({ ast, comments, js }) => {
  if (reachesI18n(ast)) return false;

  const shape = findExport(ast, 'load');
  if (shape.kind === 'other' || shape.kind === 'reexport' || shape.kind === 'star') {
    const why = shape.kind === 'star' ? starred('load') : 'it exports `load` in a shape the add-on does not merge into.';
    skip(`${why} Call the \`load\` from \`#lib/i18n.js\` in it and merge the results, as the sveltekit-i18n docs describe.`);
    return false;
  }

  // A binding the module names `load` already, and does not export, would be declared twice.
  if (shape.kind === 'none' && moduleBindings(ast).has('load')) {
    skip('it names something `load` that it does not export. Rename it, then run the add-on again.');
    return false;
  }

  if (readOnEvaluation(js, ast.body.filter((node) => shape.kind !== 'declaration' || node !== shape.node), 'load')) {
    skip('it reads `load` as it is evaluated. Call the `load` from `#lib/i18n.js` in it and merge the results, as the sveltekit-i18n docs describe.');
    return false;
  }

  const type = server ? 'LayoutServerLoad' : 'LayoutLoad';
  const local = language === 'ts' ? importTypes(ast, js, type) : type;

  // The call of the app's own `load`, when it has one, and what it returns:
  // nothing, when all it does is redirect or declare a dependency.
  let own: string | undefined;
  if (shape.kind === 'declaration') {
    const { declaration } = shape.node;
    // A binding the module assigns to again would then assign to the new export.
    if (declaration?.type === 'VariableDeclaration' && declaration.kind !== 'const') {
      skip(`it declares \`load\` with \`${declaration.kind}\`. Call the \`load\` from \`#lib/i18n.js\` in it and merge the results, as the sveltekit-i18n docs describe.`);
      return false;
    }
    // Overloads turn into the declarations of a function its body no longer is.
    const overloads = ast.body.some((node) => node.type === 'ExportNamedDeclaration' && (node.declaration?.type as string) === 'TSDeclareFunction'
      && (node.declaration as { id?: AstTypes.Identifier | null }).id?.name === 'load');
    if (overloads) {
      skip('it overloads `load`. Call the `load` from `#lib/i18n.js` in it and merge the results, as the sveltekit-i18n docs describe.');
      return false;
    }
    const why = language === 'js' ? untypable(comments, shape.node, type) : undefined;
    if (why) {
      skip(why);
      return false;
    }
    const name = unexport(ast, js, shape, 'load', freeName(js, [ast], 'ownLoad'), true);
    own = `((await ${name}(${inferReturn(ast, comments, shape.node, language, local) ? 'event' : ''})) ?? {})`;
  }
  const i18n = importNamed(ast, js, 'load', '#lib/i18n.js', 'i18nLoad');

  const typed = language === 'ts'
    ? `export const load: ${local} =`
    : `/** @type {import('./$types').${type}} */\nexport const load =`;

  let body: string;
  if (!own) {
    body = `${typed} ${i18n};`;
  } else if (server) {
    // The i18n part last: the universal \`load\` finds the server's instance
    // by the payload object it returns.
    body = `${typed} async (event) => ({ ...${own}, ...(await ${i18n}(event)) });`;
  } else {
    body = `${typed} async (event) => {
\tconst i18n = await ${i18n}(event);
\tconst own = ${own};
\t// The layout's own fields win, and \`data.i18n\` stays the instance \`use()\` takes.
\treturn { ...i18n, ...own, i18n: i18n.i18n };
};`;
  }
  js.common.appendFromString(ast, { code: body, comments });
}, { onError: () => skip(UNPARSED) });
