import { Walker, loadFile, parse, svelteConfig, type AstTypes } from '@sveltejs/sv-utils';

/**
 * `kit.paths.base` as the add-on can use it: `value` when the config states a
 * string literal (`''` included), `known: false` when it states anything the
 * add-on cannot read without running the config.
 */
export type Base = { known: true; value: string } | { known: false };

const keyName = (property: AstTypes.ObjectExpression['properties'][number]): string | undefined => {
  if (property.type !== 'Property' || property.computed) return undefined;
  const { key } = property;
  return key.type === 'Identifier' ? key.name : key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
};

const literal = (node: AstTypes.Node): string | undefined => {
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
};

/** Reads `option` off `object`: `undefined` when it is absent, `null` when a spread may hold it. */
const option = (object: AstTypes.ObjectExpression, name: string): AstTypes.Node | null | undefined => {
  const property = object.properties.find((candidate) => keyName(candidate) === name);
  if (property?.type === 'Property') return property.value;
  return object.properties.some(({ type }) => type === 'SpreadElement') ? null : undefined;
};

/**
 * Whether the `sveltekit()` call of a Vite config takes its options from
 * anything but an object literal (`as` and `satisfies` included), which
 * sv-utils reads as no options at all.
 */
const optionsElsewhere = (content: string): boolean => {
  const { ast } = parse.script(content);
  const specifier = ast.body
    .flatMap((node) => (node.type === 'ImportDeclaration' && node.source.value === '@sveltejs/kit/vite' ? node.specifiers : []))
    .find((candidate) => candidate.type === 'ImportSpecifier' && candidate.imported.type === 'Identifier' && candidate.imported.name === 'sveltekit');
  const name = specifier?.local.name ?? 'sveltekit';
  let elsewhere = false;
  Walker.walk<AstTypes.Node, null>(ast, null, {
    _(node, { next }) {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === name) {
        const [options] = node.arguments;
        if (options && options.type !== 'ObjectExpression') elsewhere = true;
      }
      next();
    },
  });
  return elsewhere;
};

const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'];

export const readBase = (cwd: string): Base => {
  let kit: AstTypes.Node;
  try {
    const config = svelteConfig.read(cwd);
    if (!config) {
      // A Vite config sv-utils does not read (`.mts`, a namespace import of
      // the plugin) may state a base.
      return VITE_CONFIGS.some((file) => loadFile(cwd, file)) ? { known: false } : { known: true, value: '' };
    }
    if (config.location.kind === 'vite' && optionsElsewhere(loadFile(cwd, config.location.path))) return { known: false };
    kit = config.kit;
  } catch {
    return { known: false };
  }
  if (kit.type !== 'ObjectExpression') return { known: false };

  const paths = option(kit, 'paths');
  if (paths === undefined) return { known: true, value: '' };
  if (paths?.type !== 'ObjectExpression') return { known: false };

  const base = option(paths, 'base');
  if (base === undefined) return { known: true, value: '' };
  const value = base === null ? undefined : literal(base);
  return value === undefined ? { known: false } : { known: true, value };
};
