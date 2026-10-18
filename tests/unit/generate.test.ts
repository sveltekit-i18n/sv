import { describe, expect, test } from 'vitest';

import { demoPage } from '../../src/generate.js';
import { readOptions, type Settings } from '../../src/options.js';

const settings = (routing: string, extensions: string[] = []): Settings => {
  const read = readOptions({ locales: 'en,cs', format: 'curly', routing, typegen: true, extensions, demo: true });
  if (typeof read === 'string') throw new Error(read);
  return read;
};

describe('demo page', () => {
  // Without type information, `svelte/no-navigation-without-resolve` passes an
  // app's own link only when its `href` is a `resolve()` call or names one, so
  // every link of the page is held to the call itself.
  test.each(['cookie', 'prefix', 'translated', 'custom'].flatMap((routing) => (
    (['ts', 'js'] as const).flatMap((language) => [[], ['stores']].map((extensions) => ({ routing, language, extensions })))
  )))('each link resolves where it is: $routing, $language, $extensions', ({ routing, language, extensions }) => {
    const page = demoPage(settings(routing, extensions), language);
    const hrefs = [...page.matchAll(/<a href=\{(.*?)\}(?= (?:hreflang|aria-current)=|>)/g)].map(([, href]) => href);
    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs).toHaveLength(page.match(/<a\b/g)?.length ?? 0);
    hrefs.forEach((href) => expect(href).toMatch(/^resolve\(.*\)$/));
  });
});
