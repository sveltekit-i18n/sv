import { sanitizeLocales } from '@sveltekit-i18n/base/utils';

export type ParsedLocales = { locales: string[]; invalid: string[] };

/**
 * The locales a comma-separated answer names, as the core will key them: each
 * tag must be well-formed (`Intl.getCanonicalLocales` rejects `en_US`), and is
 * then spelled the way the core calls a loader with it (`pt-br` → `pt-BR`).
 */
export const parseLocales = (input: unknown): ParsedLocales => {
  const tags = `${typeof input === 'string' ? input : ''}`.split(',').map((tag) => tag.trim()).filter(Boolean);
  const invalid = tags.filter((tag) => {
    try {
      Intl.getCanonicalLocales(tag);
      return false;
    } catch {
      return true;
    }
  });
  const locales = invalid.length ? [] : [...new Set(sanitizeLocales(...tags))];
  return { locales, invalid };
};
