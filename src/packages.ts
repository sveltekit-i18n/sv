import pkg from '../package.json' with { type: 'json' };

type Installed = keyof typeof pkg.devDependencies & (`@sveltekit-i18n/${string}` | 'sveltekit-i18n');

/**
 * The range a project gets: the add-on's own devDependency on the package,
 * the version its suite ran against. The family's release plan moves those to
 * the latest release before each publish.
 */
export const range = (name: Installed): string => pkg.devDependencies[name];

export type FormatId = 'curly' | 'icu' | 'mf2' | 'i18next';

export type Format = {
  id: FormatId;
  label: string;
  /** What the project depends on. Never `sveltekit-i18n` beside base. */
  packages: Installed[];
  /** Where `defineI18n` comes from. */
  kit: string;
  /** Where the `Config` type comes from, and, for a parser package, the factory. */
  from: string;
  /** Whether the config states `parser`; `sveltekit-i18n` fills the slot itself. */
  parser: boolean;
  /** The greeting, in the format's syntax, with `name` as its parameter. */
  greeting: (text: string) => string;
};

export const FORMATS: Format[] = [
  {
    id: 'curly',
    label: 'Curly Message Format (sveltekit-i18n)',
    packages: ['sveltekit-i18n'],
    kit: 'sveltekit-i18n/kit',
    from: 'sveltekit-i18n',
    parser: false,
    greeting: (text) => `${text}, {{name}}!`,
  },
  {
    id: 'icu',
    label: 'ICU MessageFormat',
    packages: ['@sveltekit-i18n/base', '@sveltekit-i18n/parser-icu'],
    kit: '@sveltekit-i18n/base/kit',
    from: '@sveltekit-i18n/parser-icu',
    parser: true,
    greeting: (text) => `${text}, {name}!`,
  },
  {
    id: 'mf2',
    label: 'Unicode MessageFormat 2',
    packages: ['@sveltekit-i18n/base', '@sveltekit-i18n/parser-mf2'],
    kit: '@sveltekit-i18n/base/kit',
    from: '@sveltekit-i18n/parser-mf2',
    parser: true,
    greeting: (text) => `${text}, {$name}!`,
  },
  {
    id: 'i18next',
    label: 'i18next',
    packages: ['@sveltekit-i18n/base', '@sveltekit-i18n/parser-i18next'],
    kit: '@sveltekit-i18n/base/kit',
    from: '@sveltekit-i18n/parser-i18next',
    parser: true,
    greeting: (text) => `${text}, {{name}}!`,
  },
];

export type ExtensionId = 'typed-access' | 'html' | 'stores';

export type Extension = {
  id: ExtensionId;
  label: string;
  package: Installed;
  /** The local name of the default import. */
  importName: string;
  /** What goes into `extensions: [ … ]`: `html` is a factory. */
  expression: string;
  /** How the demo page reads the instance once this extension is in the pipe. */
  demo: 'instance' | 'stores' | 'component';
};

/**
 * In the order the pipe needs them: `stores` last, as its output is no
 * instance, and `html` after `typed-access`, so it augments that output.
 */
export const EXTENSIONS: Extension[] = [
  {
    id: 'typed-access',
    label: 'typed-access: t.home.title()',
    package: '@sveltekit-i18n/extension-typed-access',
    importName: 'typedAccess',
    expression: 'typedAccess',
    demo: 'instance',
  },
  {
    id: 'html',
    label: 'html: markup in messages, rendered by <T>',
    package: '@sveltekit-i18n/extension-html',
    importName: 'html',
    expression: 'html({ onReport })',
    demo: 'component',
  },
  {
    id: 'stores',
    label: 'stores: $t and the other stores',
    package: '@sveltekit-i18n/extension-stores',
    importName: 'stores',
    expression: 'stores',
    demo: 'stores',
  },
];

/** Libraries another i18n setup brings, which this one would run beside. */
export const OTHER_I18N = ['svelte-i18n', '@inlang/paraglide-js', 'typesafe-i18n'];

/** What a project set up already carries, in any version. */
export const OURS = ['sveltekit-i18n', '@sveltekit-i18n/base'];
