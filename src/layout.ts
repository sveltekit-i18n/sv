import { parse, transforms, type AstTypes, type TransformFn } from '@sveltejs/sv-utils';

import { UNPARSED, freeName, importNamed, importTypes, reachesI18n, typesAlias } from './ast.js';

type Options = {
  language: 'ts' | 'js';
  skip: (reason: string) => void;
};

const LAYOUT_PROPS = "import('./$types').LayoutProps";
const LAYOUT_DATA = "import('./$types').LayoutData";

/** The root layout as the add-on creates it when the project has none. */
export const newLayout = (language: 'ts' | 'js'): string => `<script${language === 'ts' ? ' lang="ts"' : ''}>
\timport { use } from '#lib/i18n.js';
${language === 'ts' ? "\timport type { LayoutProps } from './$types';\n" : ''}
${language === 'ts' ? '\tlet { data, children }: LayoutProps = $props();' : `\t/** @type {${LAYOUT_PROPS}} */\n\tlet { data, children } = $props();`}

\tuse(() => data);
</script>

{@render children()}
`;

/** Types an intersection member puts in parentheses. */
const LOOSE = ['TSUnionType', 'TSFunctionType', 'TSConstructorType', 'TSConditionalType'];

/** What the add-on reads of a TypeScript type node; `AstTypes` names only a few kinds. */
type TypeNode = {
  type: string;
  start?: number;
  end?: number;
  members?: TypeNode[];
  key?: { type: string; name?: string; value?: unknown };
  typeName?: { type: string; name?: string };
  qualifier?: { type: string; name?: string };
  argument?: { value?: unknown };
};

const declaresData = ({ members = [] }: TypeNode): boolean => members.some(({ type, key }) => (
  type === 'TSPropertySignature' && (key?.type === 'Identifier' ? key.name === 'data' : key?.value === 'data')
));

/**
 * The JSDoc type `type` of the props with `data` declared beside what it
 * declares: a member of an object type, an intersection with anything else
 * but `LayoutProps`, which has it already.
 */
const jsdocWithData = (type: string): string => {
  // The asterisks that open the lines of a comment, blanked in place.
  const bare = type.replace(/(\n[ \t]*)\*/g, '$1 ');
  let node: TypeNode;
  try {
    node = (parse.script(`type Props = ${bare};`).ast.body[0] as unknown as { typeAnnotation: TypeNode }).typeAnnotation;
  } catch {
    return type;
  }
  if (node.type === 'TSTypeLiteral') {
    if (declaresData(node)) return type;
    const last = node.members?.at(-1);
    if (!last) return `{ data: ${LAYOUT_DATA} }`;
    // Positions count from the type, which starts after the blanks before it.
    const cut = last.end! - node.start! + (bare.length - bare.trimStart().length);
    const head = type.slice(0, cut);
    return `${head}${/[,;]$/.test(head) ? ' ' : ', '}data: ${LAYOUT_DATA}${type.slice(cut)}`;
  }
  const layoutProps = node.type === 'TSImportType' && node.qualifier?.type === 'Identifier' && node.qualifier.name === 'LayoutProps'
    && ['./$types', './$types.js'].includes(String(node.argument?.value));
  if (layoutProps) return type;
  return `${LOOSE.includes(node.type) ? `(${type})` : type} & { data: ${LAYOUT_DATA} }`;
};

/** Where the braces of the `@type` tag of a comment are, outside the strings of the type. */
const typeTag = (comment: string): [number, number] | undefined => {
  const at = comment.search(/@type\s*\{/);
  if (at === -1) return undefined;
  const open = comment.indexOf('{', at);
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < comment.length; index++) {
    const char = comment[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = undefined;
    } else if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth === 0) {
      return [open, index];
    }
  }
  return undefined;
};

const isProps = (node: AstTypes.Node | null | undefined): boolean => (
  node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === '$props'
);

/**
 * Hands the layout's `data` to `use()`, taking `data` from the existing
 * `$props()` or adding it there. Props without a type are typed as
 * `LayoutProps`; a type they have stays, with `data` declared in it.
 */
export const rootLayout = ({ language, skip }: Options): TransformFn => transforms.svelteScript({ language }, ({ ast, js }) => {
  const program = ast.instance.content;
  if (reachesI18n(program)) return false;
  if (program.body.some((node) => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration')) {
    skip('it declares its props with `export let`. Pass the layout\'s `data` to `use()` from `#lib/i18n.js`.');
    return false;
  }

  const index = program.body.findIndex((node) => node.type === 'VariableDeclaration' && node.declarations.some(({ init }) => isProps(init)));
  let declaration = program.body[index] as AstTypes.VariableDeclaration | undefined;
  let data: string;
  // Whether the props are read for `data` the layout did not take, so a type they have must declare it.
  let added = false;

  if (!declaration) {
    // A layout with no props renders no page either; the add-on gives it
    // `data` only.
    declaration = js.common.parseStatement('let { data } = $props();') as AstTypes.VariableDeclaration;
    program.body.push(declaration);
    data = 'data';
  } else {
    const declarator = declaration.declarations.find(({ init }) => isProps(init))!;
    if (declarator.id.type === 'Identifier') {
      data = `${declarator.id.name}.data`;
      added = true;
    } else if (declarator.id.type === 'ObjectPattern') {
      const pattern = declarator.id;
      const existing = pattern.properties.find((property) => (
        property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === 'data'
      ));
      const rest = pattern.properties.find((property) => property.type === 'RestElement');
      if (existing?.type === 'Property') {
        const value = existing.value.type === 'AssignmentPattern' ? existing.value.left : existing.value;
        if (value.type !== 'Identifier') {
          skip('it destructures `data` further. Pass the layout\'s `data` to `use()` from `#lib/i18n.js`.');
          return false;
        }
        data = value.name;
      } else if (rest?.type === 'RestElement' && rest.argument.type === 'Identifier') {
        // Taking `data` out of the rest would take it from where the layout reads it.
        data = `${rest.argument.name}.data`;
        added = true;
      } else {
        // The template's snippets are names of the script's scope too.
        data = freeName(js, [program, ast.fragment], 'data');
        const property = (js.common.parseExpression(`({ ${data === 'data' ? 'data' : `data: ${data}`} })`) as AstTypes.ObjectExpression).properties[0] as AstTypes.AssignmentProperty;
        pattern.properties.push(property);
        added = true;
      }
    } else {
      skip('its `$props()` is not destructured in a shape the add-on reads. Pass the layout\'s `data` to `use()` from `#lib/i18n.js`.');
      return false;
    }
  }

  // A type the props have already is the app's, and stays, declaring `data` once they take it.
  const id = declaration.declarations.find(({ init }) => isProps(init))!.id as AstTypes.Pattern & { typeAnnotation?: AstTypes.TSTypeAnnotation };
  const reference = (name: string): AstTypes.TSTypeReference => ({ type: 'TSTypeReference', typeName: { type: 'Identifier', name } });
  if (language === 'ts' && !id.typeAnnotation) {
    // `typeAnnotateDeclarator` annotates an identifier only, and the props
    // are destructured.
    id.typeAnnotation = { type: 'TSTypeAnnotation', typeAnnotation: reference(importTypes(program, js, 'LayoutProps')) };
  } else if (language === 'ts' && added) {
    const annotation = id.typeAnnotation!;
    const type = annotation.typeAnnotation as TypeNode;
    const isLayoutProps = type.type === 'TSTypeReference' && type.typeName?.type === 'Identifier' && type.typeName.name === typesAlias(program, js, 'LayoutProps');
    if (!isLayoutProps && !declaresData(type)) {
      const member = {
        type: 'TSPropertySignature',
        key: { type: 'Identifier', name: 'data' },
        computed: false,
        typeAnnotation: { type: 'TSTypeAnnotation', typeAnnotation: reference(importTypes(program, js, 'LayoutData')) },
      };
      if (type.type === 'TSTypeLiteral') type.members!.push(member);
      else {
        const first = LOOSE.includes(type.type) ? { type: 'TSParenthesizedType', typeAnnotation: type } : type;
        annotation.typeAnnotation = { type: 'TSIntersectionType', types: [first, { type: 'TSTypeLiteral', members: [member] }] } as unknown as AstTypes.TSTypeAnnotation['typeAnnotation'];
      }
    }
  } else if (added) {
    // Svelte prints the comments of the component, by position, from its own
    // list: the JSDoc type the declaration carries is edited there.
    const leading = (declaration as { leadingComments?: AstTypes.Comment[] }).leadingComments ?? [];
    const comment = ast.comments.find(({ type, value, start }) => type === 'Block' && /@type\s*\{/.test(value) && leading.some((candidate) => candidate.start === start));
    const tag = comment && typeTag(comment.value);
    if (comment && tag) {
      const [open, close] = tag;
      comment.value = `${comment.value.slice(0, open + 1)}${jsdocWithData(comment.value.slice(open + 1, close))}${comment.value.slice(close)}`;
    }
  }

  const use = importNamed(program, js, 'use', '#lib/i18n.js');
  program.body.splice(program.body.indexOf(declaration) + 1, 0, js.common.parseStatement(`${use}(() => ${data});`));
}, { onError: () => skip(UNPARSED) });
