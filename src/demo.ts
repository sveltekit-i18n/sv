import { transforms, type AstTypes, type TransformFn } from '@sveltejs/sv-utils';

const NAME = 'sveltekit-i18n';

/**
 * Kit 3's `resolve()` reads a path with a leading slash as a route ID, and the
 * demo's route sits under the optional locale segment: the entry
 * `defineDemoPage` adds names a route that does not exist, so it is pointed
 * at the real one. `defineDemoPage` adds its entry again on a second run,
 * which then goes.
 */
export const prefixDemoLink = (language: 'ts' | 'js', route: string): TransformFn => transforms.svelteScript({ language }, ({ ast, js }) => {
  const program = ast.instance.content;
  const list = program.body
    .flatMap((node) => (node.type === 'VariableDeclaration' ? node.declarations : []))
    .find(({ id }) => id.type === 'Identifier' && id.name === 'demos')?.init;
  if (list?.type !== 'ArrayExpression') return false;

  const generated = js.common.parseExpression(`({ name: '${NAME}', href: resolve('/demo/${NAME}') })`);
  const ours = js.common.parseExpression(`({ name: '${NAME}', href: resolve('${route}', {}) })`) as AstTypes.ObjectExpression;
  const index = list.elements.findIndex((element) => element && js.common.areNodesEqual(element, generated));
  if (index === -1) return false;

  if (list.elements.some((element) => element && js.common.areNodesEqual(element, ours))) list.elements.splice(index, 1);
  else list.elements.splice(index, 1, ours);
});
