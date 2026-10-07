import { type AstTypes, type js as jsUtils } from '@sveltejs/sv-utils';

export type Js = typeof jsUtils;
export type Program = AstTypes.Program;

/** Why a file that does not parse was left alone. */
export const UNPARSED = 'it does not parse.';

/** `#lib/i18n`, with or without an extension, and `$lib/i18n` on an older app. */
const I18N_MODULE = /^[#$]lib\/i18n(?:\.[jt]s)?$/;

/** Whether the module already imports or re-exports anything from `$lib/i18n`. */
export const reachesI18n = (ast: Program): boolean => ast.body.some((node) => (
  (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
  && typeof node.source?.value === 'string'
  && I18N_MODULE.test(node.source.value)
));

/**
 * How a module exports `name`:
 * - `declaration`: `export const name = …` (one declarator) or
 *   `export (async) function name`, which can be unexported and wrapped;
 * - `reexport`: `export { name } from '…'` or `export { x as name } from '…'`;
 * - `other`: a local exported by specifier, a destructuring, `export let`
 *   with siblings — left alone;
 * - `star`: none by name, and an `export * from` that may hold one, which an
 *   export added beside it would replace — left alone;
 * - `none`: no such export.
 */
export type ExportShape =
  | { kind: 'declaration'; node: AstTypes.ExportNamedDeclaration }
  | { kind: 'reexport'; node: AstTypes.ExportNamedDeclaration; specifier: AstTypes.ExportSpecifier; source: string }
  | { kind: 'other' }
  | { kind: 'star' }
  | { kind: 'none' };

/** Why a module whose `export *` may hold `name` was left alone. */
export const starred = (name: string): string => `it re-exports everything from another module (\`export *\`), which may hold \`${name}\`, and an export added beside it would replace that one.`;

/** The names a binding pattern declares. */
const bound = (pattern: AstTypes.Pattern): string[] => {
  switch (pattern.type) {
    case 'Identifier': return [pattern.name];
    case 'ObjectPattern': return pattern.properties.flatMap((property) => bound(property.type === 'RestElement' ? property : property.value));
    case 'ArrayPattern': return pattern.elements.flatMap((element) => (element ? bound(element) : []));
    case 'RestElement': return bound(pattern.argument);
    case 'AssignmentPattern': return bound(pattern.left);
    default: return [];
  }
};

const nameOf = (node: AstTypes.Identifier | AstTypes.Literal): string | undefined => (
  node.type === 'Identifier' ? node.name : typeof node.value === 'string' ? node.value : undefined
);

export const findExport = (ast: Program, name: string): ExportShape => {
  for (const node of ast.body) {
    if (node.type !== 'ExportNamedDeclaration') continue;

    const { declaration } = node;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === name) {
      return { kind: 'declaration', node };
    }
    if (declaration?.type === 'VariableDeclaration') {
      const declarator = declaration.declarations.find(({ id }) => bound(id).includes(name));
      if (declarator) {
        return declarator.id.type === 'Identifier' && declaration.declarations.length === 1 ? { kind: 'declaration', node } : { kind: 'other' };
      }
    }

    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ExportSpecifier' || nameOf(specifier.exported) !== name) continue;
      const source = node.source?.value;
      return typeof source === 'string' ? { kind: 'reexport', node, specifier, source } : { kind: 'other' };
    }
  }
  const stars = ast.body.filter((node) => node.type === 'ExportAllDeclaration');
  // `export * as name` exports a namespace, which no handle or load is.
  if (stars.some(({ exported }) => exported && nameOf(exported) === name)) return { kind: 'other' };
  return stars.some(({ exported }) => !exported) ? { kind: 'star' } : { kind: 'none' };
};

/**
 * Turns the export of `name` into a module-local binding and returns its
 * name: the import of a re-exported one, under `local` unless the module
 * imports it already, or the declaration itself, its overloads included,
 * renamed to `local` when `rename` is set. Nothing else is renamed: a
 * reference of the module then means the export that replaces it, as an
 * import of it from another module does.
 */
export const unexport = (ast: Program, js: Js, shape: Extract<ExportShape, { kind: 'declaration' | 'reexport' }>, name: string, local: string, rename: boolean): string => {
  if (shape.kind === 'reexport') {
    const { node, specifier, source } = shape;
    node.specifiers = node.specifiers.filter((other) => other !== specifier);
    if (!node.specifiers.length) ast.body = ast.body.filter((other) => other !== node);
    return importNamed(ast, js, nameOf(specifier.local) ?? name, source, local);
  }

  for (const [index, node] of ast.body.entries()) {
    if (node.type !== 'ExportNamedDeclaration' || !node.declaration) continue;
    const declaration = node.declaration as AstTypes.Node & { id?: AstTypes.Node | null };
    const overload = (declaration.type as string) === 'TSDeclareFunction' && declaration.id?.type === 'Identifier' && declaration.id.name === name;
    if (node !== shape.node && !overload) continue;
    ast.body[index] = node.declaration;
    if (!rename) continue;
    const id = declaration.type === 'VariableDeclaration' ? declaration.declarations[0].id : declaration.id;
    if (id?.type === 'Identifier') id.name = local;
  }
  return rename ? local : name;
};

/** The values the module scope binds: its imports and its top-level declarations, exported or not. */
export const moduleBindings = (ast: Program): Set<string> => new Set(ast.body.flatMap((node): string[] => {
  if (node.type === 'ImportDeclaration') return node.specifiers.map(({ local }) => local.name);
  const declaration = (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration' ? node.declaration : node) as AstTypes.Node | null;
  if (declaration?.type === 'VariableDeclaration') return declaration.declarations.flatMap(({ id }) => bound(id));
  const { id } = (declaration ?? {}) as { id?: AstTypes.Node | null };
  const valued = ['FunctionDeclaration', 'ClassDeclaration', 'TSDeclareFunction', 'TSEnumDeclaration', 'TSModuleDeclaration', 'TSImportEqualsDeclaration'];
  return declaration && valued.includes(declaration.type) && id?.type === 'Identifier' ? [id.name] : [];
}));

/**
 * A name nothing in `roots` takes. `js.identifiers.freeName` misses an import
 * that keeps its name (`import { x } from '…'`), whose `imported` and `local`
 * are one node.
 */
export const freeName = (js: Js, roots: Parameters<Js['identifiers']['freeName']>[0], base: string): string => {
  const imported = new Set(roots.flatMap((root) => (root.type === 'Program' ? root.body : []).flatMap((node) => (
    node.type === 'ImportDeclaration' ? node.specifiers.map(({ local }) => local.name) : []
  ))));
  for (let counter = 1; ; counter++) {
    const name = counter === 1 ? base : `${base}${counter}`;
    if (!imported.has(name) && js.identifiers.freeName(roots, name) === name) return name;
  }
};

/** The local name a module imports `name` from `from` under, adding the import if it has none. */
export const importNamed = (ast: Program, js: Js, name: string, from: string, preferred = name): string => {
  const existing = js.imports.find(ast, { name, from });
  if (existing.alias) return existing.alias;
  const local = freeName(js, [ast], preferred);
  js.imports.addNamed(ast, { imports: { [name]: local }, from });
  return local;
};

/** The local name of a type of `./$types` the module imports, with or without its extension. */
export const typesAlias = (ast: Program, js: Js, name: string): string | undefined => ['./$types', './$types.js']
  .map((from) => js.imports.find(ast, { name, from }).alias)
  .find(Boolean);

/** The local name of a type of `./$types`, adding the import if the module has none. */
export const importTypes = (ast: Program, js: Js, name: string): string => {
  const alias = typesAlias(ast, js, name);
  if (alias) return alias;
  const local = freeName(js, [ast], name);
  js.imports.addNamed(ast, { imports: { [name]: local }, from: './$types', isType: true });
  return local;
};

/** The names a module exports, or `undefined` when an `export *` may export more. */
export const exportedNames = (ast: Program): string[] | undefined => {
  if (ast.body.some((node) => node.type === 'ExportAllDeclaration' && !node.exported)) return undefined;
  return ast.body.flatMap((node) => {
    if (node.type === 'ExportAllDeclaration') return node.exported ? [nameOf(node.exported)].filter((name) => name !== undefined) : [];
    if (node.type !== 'ExportNamedDeclaration') return [];
    const { declaration } = node;
    const declared = declaration?.type === 'VariableDeclaration'
      ? declaration.declarations.flatMap(({ id }) => bound(id))
      : declaration && 'id' in declaration && declaration.id?.type === 'Identifier' ? [declaration.id.name] : [];
    const specified = node.specifiers.flatMap((specifier) => (specifier.type === 'ExportSpecifier' ? [nameOf(specifier.exported)] : []));
    return [...declared, ...specified].filter((name): name is string => name !== undefined);
  });
};
