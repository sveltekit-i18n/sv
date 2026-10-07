import { transforms, type AstTypes, type TransformFn } from '@sveltejs/sv-utils';

import { UNPARSED, importNamed, type Program } from './ast.js';

type Options = {
  /** Where the locale helpers are imported from, with the file's own extension. */
  from: string;
  skip: (reason: string) => void;
};

/** `#lib/locale`, under any extension: the matcher the add-on writes imports it. */
const LOCALE_MODULE = /^[#$]lib\/locale(?:\.[jt]s)?$/;

const isCall = (node: AstTypes.Node | null | undefined, name: string): node is AstTypes.CallExpression => (
  node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name
);

const keyName = (property: AstTypes.ObjectExpression['properties'][number]): string | undefined => {
  if (property.type !== 'Property' || property.computed) return undefined;
  const { key } = property;
  return key.type === 'Identifier' ? key.name : key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
};

/** The object of `export const params = defineParams({ … })`. */
const paramsObject = (ast: Program): AstTypes.ObjectExpression | undefined => {
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration?.type !== 'VariableDeclaration') continue;
    for (const { id, init } of node.declaration.declarations) {
      if (id.type !== 'Identifier' || id.name !== 'params' || !isCall(init, 'defineParams')) continue;
      const [argument] = init.arguments;
      return argument?.type === 'ObjectExpression' ? argument : undefined;
    }
  }
  return undefined;
};

/** Adds the `locale` matcher to a `params` file the project has already. */
export const addMatcher = ({ from, skip }: Options): TransformFn => transforms.script(({ ast, js }) => {
  if (ast.body.some((node) => node.type === 'ImportDeclaration' && typeof node.source.value === 'string' && LOCALE_MODULE.test(node.source.value))) {
    return false;
  }

  const object = paramsObject(ast);
  if (!object) {
    skip('it has no `export const params = defineParams({ … })` to add the `locale` matcher to. Add it as `examples/locale-router-advanced` does.');
    return false;
  }
  if (object.properties.some((property) => keyName(property) === 'locale')) {
    skip('it defines a `locale` matcher already. Make it accept the prefixed locales only, with `isPrefixed` from `#lib/locale`.');
    return false;
  }

  const isPrefixed = importNamed(ast, js, 'isPrefixed', from);
  const matcher = js.common.parseExpression(`({ locale: (param) => (${isPrefixed}(param) ? param : undefined) })`) as AstTypes.ObjectExpression;
  object.properties.push(...matcher.properties);
}, { onError: () => skip(UNPARSED) });
