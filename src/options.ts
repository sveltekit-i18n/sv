import { color } from '@sveltejs/sv-utils';
import { defineAddonOptions } from 'sv';

import { parseLocales } from './locales.js';
import { EXTENSIONS, FORMATS, type ExtensionId } from './packages.js';

export type Routing = 'cookie' | 'prefix' | 'custom';

export const options = defineAddonOptions()
  .add('locales', {
    question: `Which locales? ${color.optional('(comma-separated; the first is the one a visitor gets by default)')}`,
    type: 'string',
    default: 'en',
    validate: (value) => {
      const { locales, invalid } = parseLocales(value);
      if (invalid.length) return `Not a locale: ${invalid.join(', ')}`;
      if (!locales.length) return 'Name at least one locale, e.g. en';
      return undefined;
    },
  })
  .add('format', {
    question: 'Which message format?',
    type: 'select',
    default: 'curly',
    options: FORMATS.map(({ id, label }) => ({ value: id, label })),
  })
  .add('routing', {
    question: 'Where does the locale come from?',
    type: 'select',
    default: 'cookie',
    options: [
      { value: 'cookie', label: 'cookie', hint: 'the `lang` cookie, then Accept-Language; URLs stay as they are' },
      { value: 'prefix', label: 'URL prefix', hint: '/about, /cs/about' },
      { value: 'custom', label: 'custom', hint: 'your own source, such as a user preference, through event.locals' },
    ],
  })
  .add('typegen', {
    question: `Generate the types of your keys and payloads? ${color.optional('(@sveltekit-i18n/typegen)')}`,
    type: 'boolean',
    default: true,
  })
  .add('extensions', {
    question: 'Which extensions?',
    type: 'multiselect',
    default: [] as ExtensionId[],
    options: EXTENSIONS.map(({ id, label }) => ({ value: id, label })),
    required: false,
  })
  .add('demo', {
    question: 'Add a demo page?',
    type: 'boolean',
    default: true,
  })
  .build();

export type Settings = {
  locales: string[];
  format: (typeof FORMATS)[number];
  routing: Routing;
  typegen: boolean;
  extensions: (typeof EXTENSIONS)[number][];
  demo: boolean;
};

/**
 * Options given on the command line or to `add()` skip `validate` and arrive
 * as they were typed, so every one is read again here.
 */
export const readOptions = (input: Record<string, unknown>): Settings | string => {
  const { locales, invalid } = parseLocales(input.locales);
  if (invalid.length) return `Not a locale: ${invalid.join(', ')}.`;
  if (!locales.length) return 'Name at least one locale, e.g. `locales:en`.';

  const format = FORMATS.find(({ id }) => id === input.format);
  if (!format) return `Unknown format \`${String(input.format)}\`: use ${FORMATS.map(({ id }) => id).join(', ')}.`;

  const routing = input.routing;
  if (routing !== 'cookie' && routing !== 'prefix' && routing !== 'custom') {
    return `Unknown routing \`${String(routing)}\`: use cookie, prefix or custom.`;
  }

  if (typeof input.typegen !== 'boolean') return '`typegen` takes yes or no.';
  if (typeof input.demo !== 'boolean') return '`demo` takes yes or no.';

  const requested: unknown = input.extensions ?? [];
  if (!Array.isArray(requested)) return '`extensions` takes a list, or none.';
  const ids = (requested as unknown[]).map((id) => (typeof id === 'string' ? id.trim() : id));
  const unknown = ids.filter((id) => !EXTENSIONS.some((extension) => extension.id === id));
  if (unknown.length) {
    return `Unknown extension ${unknown.map(String).join(', ')}: use ${EXTENSIONS.map(({ id }) => id).join(', ')}, or none.`;
  }

  return {
    locales,
    format,
    routing,
    typegen: input.typegen,
    extensions: EXTENSIONS.filter(({ id }) => ids.includes(id)),
    demo: input.demo,
  };
};
