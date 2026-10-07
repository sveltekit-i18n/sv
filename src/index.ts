import {
  color,
  defineDemoPage,
  fileExists,
  isVersionUnsupportedBelow,
  libSubpathImports,
  loadFile,
  parse,
  transforms,
  type TransformFn,
} from '@sveltejs/sv-utils';
import { defineAddon } from 'sv';

import { UNPARSED, exportedNames, importNamed } from './ast.js';
import { readBase } from './base.js';
import { prefixDemoLink } from './demo.js';
import { demoPage, extractParams, i18nModule, json, localeModule, messages, paramsModule } from './generate.js';
import { hooksServer } from './hooks.js';
import { newLayout, rootLayout } from './layout.js';
import { layoutLoad } from './load.js';
import { options, readOptions } from './options.js';
import { OTHER_I18N, OURS, range } from './packages.js';
import { addMatcher } from './params.js';

type Language = 'ts' | 'js';

const DOCS = 'https://sveltekit-i18n.github.io';
const UPGRADE = 'https://github.com/sveltekit-i18n/lib/blob/master/docs/TROUBLESHOOTING.md#upgrading-from-v2';
const EXAMPLE = 'https://github.com/sveltekit-i18n/lib/tree/master/examples/locale-router-advanced';

/**
 * What `run()` decided, for `nextSteps`, which only sees the options. Reset at
 * every run: `sv/testing` runs the add-on several times in one process.
 */
const report = {
  /** Every file left alone, and why. */
  notes: [] as string[],
  /** The `$lib/i18n` module, under the extension it has. */
  i18n: '',
  /** The `handle` stub that fills `event.locals.lang`, once it is written. */
  stub: '',
};

const extensionOf = (path: string): Language => (path.endsWith('.ts') ? 'ts' : 'js');

/** The file at `base` under the extension that exists, the project's language first; the project's language when neither does. */
const existing = (cwd: string, base: string, language: Language): string => {
  const other = language === 'ts' ? 'js' : 'ts';
  return [language, other].map((extension) => `${base}.${extension}`).find((path) => fileExists(cwd, path)) ?? `${base}.${language}`;
};

/** The language of a component's `<script>`, which an existing one states whatever the project's language. */
const scriptLanguage = (content: string, fallback: Language): Language => {
  try {
    const lang = parse.svelte(content).ast.instance?.attributes.find((attribute) => attribute.type === 'Attribute' && attribute.name === 'lang');
    if (!lang || lang.type !== 'Attribute') return fallback;
    const value = Array.isArray(lang.value) ? lang.value.map((part) => ('data' in part ? part.data : '')).join('') : '';
    return value === 'ts' ? 'ts' : 'js';
  } catch {
    // The transform reports a component that does not parse.
    return fallback;
  }
};

/** Records why `path` was left alone. */
const skipper = (path: string) => (reason: string): void => {
  report.notes.push(`${color.path(path)} was left alone: ${reason}`);
};

/** A transform of sv-utils' own that takes no `onError`, made to skip a file that does not parse. */
const guarded = (path: string, transform: TransformFn): TransformFn => (content) => {
  try {
    return transform(content);
  } catch {
    skipper(path)(UNPARSED);
    return false;
  }
};

/** Creates a file the project lacks; one it has already is kept as it is. */
const create = (text: () => string) => (content: string): string | false => (content.trim() ? false : text());

export default defineAddon({
  id: 'sveltekit-i18n',
  shortDescription: 'i18n with sveltekit-i18n',
  homepage: DOCS,
  options,

  setup: ({ isKit, dependencyVersion, unsupported }) => {
    if (!isKit) {
      unsupported('Requires SvelteKit');
      return;
    }
    const kit = dependencyVersion('@sveltejs/kit');
    if (kit && isVersionUnsupportedBelow(kit, '3')) unsupported('Requires SvelteKit 3 or newer');
  },

  run: ({ cwd, sv, options: input, cancel, isKit, language, directory, file, dependencyVersion }) => {
    report.notes = [];
    report.i18n = '';
    report.stub = '';

    // Every check that can cancel runs before the first write: `cancel()`
    // undoes nothing `sv.file()` wrote.
    if (!isKit) return cancel('sveltekit-i18n needs SvelteKit.');
    const kit = dependencyVersion('@sveltejs/kit');
    if (kit && isVersionUnsupportedBelow(kit, '3')) return cancel('sveltekit-i18n\'s add-on needs SvelteKit 3 or newer.');

    const settings = readOptions(input);
    if (typeof settings === 'string') return cancel(settings);
    const { locales, format, routing, extensions, typegen, demo } = settings;

    for (const name of OURS) {
      const version = dependencyVersion(name);
      if (version === undefined) continue;
      const old = isVersionUnsupportedBelow(version, '3') ? ` To move it from v2, see ${UPGRADE}` : '';
      return cancel(`The project depends on \`${name}\` already. The add-on sets sveltekit-i18n up for the first time; it does not migrate between formats or versions.${old}`);
    }

    const base = readBase(cwd);
    if (!base.known && routing === 'prefix') {
      return cancel('`routing: prefix` needs `kit.paths.base` as a string literal: the locale helpers strip it from every path, and they run where `$app/paths` does not exist. Set the base as a literal, or pick another routing.');
    }
    const basePath = base.known && base.value ? base.value : undefined;

    const i18nPath = existing(cwd, `${directory.lib}/i18n`, language);
    const i18nContent = loadFile(cwd, i18nPath);
    if (i18nContent.trim() && !i18nContent.includes('defineI18n')) {
      return cancel(`\`${i18nPath}\` exists already and does not call \`defineI18n\`. Move it out of the way, or wire it as ${DOCS} shows.`);
    }

    const localePath = existing(cwd, `${directory.lib}/locale`, language);
    if (routing === 'prefix') {
      const content = loadFile(cwd, localePath);
      if (content.trim()) {
        // What `#lib/i18n`, the `locale` matcher and the demo page import from it.
        const needed = ['localeOf', 'isPrefixed', ...(demo ? ['LOCALES', 'pathOf', 'routeOf'] : [])];
        let names: string[] | undefined;
        try {
          names = exportedNames(parse.script(content).ast);
        } catch {
          return cancel(`\`${localePath}\` exists already and does not parse. Move it out of the way for \`routing: prefix\`.`);
        }
        const missing = names && needed.filter((name) => !names.includes(name));
        if (missing?.length) {
          return cancel(`\`${localePath}\` exists already and does not export ${missing.map((name) => `\`${name}\``).join(', ')}. Move it out of the way for \`routing: prefix\`.`);
        }
      }
    }

    report.i18n = i18nPath;
    for (const name of OTHER_I18N) {
      if (dependencyVersion(name) !== undefined) {
        report.notes.push(`The project depends on ${color.addon(name)} too. Two i18n libraries translate the same app twice: remove the one you leave.`);
      }
    }
    if (!base.known) {
      report.notes.push(`${color.path('kit.paths.base')} is not a string literal, so ${color.path(i18nPath)} has no \`basePath\`. Set it to the same value once a loader names \`routes\`.`);
    }

    // The translations, the i18n module and the locale helpers.
    for (const locale of locales) {
      sv.file(`${directory.lib}/translations/${locale}/common.json`, create(() => json(messages(settings, locale))));
    }
    sv.file(i18nPath, create(() => i18nModule(settings, extensionOf(i18nPath), basePath)));

    if (routing === 'prefix') {
      sv.file(localePath, create(() => localeModule(locales, extensionOf(localePath), basePath)));
      const paramsPath = existing(cwd, `${directory.src}/params`, language);
      const from = `#lib/locale.${extensionOf(localePath)}`;
      sv.file(paramsPath, (content) => (content.trim() ? addMatcher({ from, skip: skipper(paramsPath) })(content) : paramsModule(from)));
    }

    // `#lib`, which every generated import goes through.
    sv.file(file.package, transforms.json<{ imports?: Record<string, string> }>(({ data }) => {
      const imports = data.imports ?? {};
      const missing = Object.entries(libSubpathImports(directory.lib)).filter(([key]) => !(key in imports));
      if (!missing.length) return false;
      data.imports = { ...imports, ...Object.fromEntries(missing) };
    }));

    // The wiring: `handle`, both layout loads and `use()`.
    const hooksPath = existing(cwd, `${directory.src}/hooks.server`, language);
    sv.file(hooksPath, hooksServer({ language: extensionOf(hooksPath), routing, skip: skipper(hooksPath), stub: (name) => { report.stub = name; } }));

    for (const server of [true, false]) {
      const path = existing(cwd, `${directory.kitRoutes}/${server ? '+layout.server' : '+layout'}`, language);
      sv.file(path, layoutLoad({ language: extensionOf(path), server, skip: skipper(path) }));
    }

    const layoutPath = `${directory.kitRoutes}/+layout.svelte`;
    sv.file(layoutPath, (content) => (
      content.trim()
        ? rootLayout({ language: scriptLanguage(content, language), skip: skipper(layoutPath) })(content)
        : newLayout(language)
    ));

    sv.file(`${directory.src}/app.html`, transforms.html(({ ast, html }) => {
      const root = ast.nodes.find((node) => node.type === 'RegularElement' && node.name === 'html');
      if (root?.type !== 'RegularElement') {
        skipper(`${directory.src}/app.html`)('it has no `<html>` element. Put `lang="%lang%" dir="%dir%"` on it.');
        return false;
      }
      html.addAttribute(root, 'lang', '%lang%');
      html.addAttribute(root, 'dir', '%dir%');
    }, { onError: () => skipper(`${directory.src}/app.html`)(UNPARSED) }));

    if (routing === 'custom') {
      const path = `${directory.src}/app.d.ts`;
      sv.file(path, transforms.script(({ ast, comments, js }) => {
        const locals = js.kit.addGlobalAppInterface(ast, { name: 'Locals' });
        if (locals.body.body.some((property) => js.common.hasTypeProperty(property, { name: 'lang' }))) return false;
        comments.remove((comment) => comment.type === 'Line' && comment.value.trim() === 'interface Locals {}');
        locals.body.body.push(js.common.createTypeProperty('lang', 'string', true));
      }, { onError: () => skipper(path)(UNPARSED) }));
    }

    if (typegen) {
      if (fileExists(cwd, file.viteConfig)) {
        sv.file(file.viteConfig, transforms.script(({ ast, content, js }) => {
          if (content.includes('typegen(')) return false;
          const plugin = importNamed(ast, js, 'typegen', '@sveltekit-i18n/typegen');
          js.vite.addPlugin(ast, { code: `${plugin}({ config: '${i18nPath}', extractParams: ${extractParams(settings)} })` });
        }, { onError: () => skipper(file.viteConfig)(UNPARSED) }));
      } else {
        report.notes.push(`The Vite config is not ${color.path(file.viteConfig)}, so typegen's plugin is not in it. Add \`typegen({ config: '${i18nPath}', extractParams: ${extractParams(settings)} })\` from \`@sveltekit-i18n/typegen\` after \`sveltekit()\`.`);
      }
      sv.file(file.gitignore, transforms.text(({ content, text }) => text.upsert(content, 'src/i18n-schema.d.ts', { comment: 'sveltekit-i18n: generated by @sveltekit-i18n/typegen' })));
    }

    if (demo) {
      const page = defineDemoPage('sveltekit-i18n', language, directory.kitRoutes);
      const [linksPath, links] = page.links;
      // The prefixed locales reach the page through the optional segment.
      const route = routing === 'prefix' ? '/[[lang=locale]]/demo/sveltekit-i18n' : '/demo/sveltekit-i18n';
      sv.file(linksPath, guarded(linksPath, routing === 'prefix'
        ? (content) => {
          const linked = links(content);
          return linked && prefixDemoLink(scriptLanguage(linked, language), route)(linked);
        }
        : links));
      sv.file(page.layout[0], guarded(page.layout[0], page.layout[1]));
      sv.file(`${directory.kitRoutes}${route}/+page.svelte`, create(() => demoPage(settings, language)));
    }

    // Last: a project that depends on the core is one a later run refuses.
    for (const name of format.packages) sv.dependency(name, range(name));
    for (const extension of extensions) sv.dependency(extension.package, range(extension.package));
    if (typegen) sv.devDependency('@sveltekit-i18n/typegen', range('@sveltekit-i18n/typegen'));
  },

  nextSteps: ({ options: input, language, directory }) => {
    const settings = readOptions(input);
    if (typeof settings === 'string') return [];
    const { format, routing } = settings;

    const steps = [
      `Add your messages under ${color.path(`${directory.lib}/translations/<locale>/`)}, and a loader for each new namespace in ${color.path(report.i18n)}.`,
      `Docs: ${color.website(DOCS)}`,
      format.id === 'curly'
        ? `Never install ${color.addon('@sveltekit-i18n/base')} or a parser beside ${color.addon('sveltekit-i18n')}: the app would carry two copies of the core.`
        : `Never install ${color.addon('sveltekit-i18n')} beside ${color.addon('@sveltekit-i18n/base')}: the app would carry two copies of the core.`,
    ];

    if (routing === 'prefix') {
      steps.push(
        `Move your routes under ${color.route(`${directory.kitRoutes}/[[lang=locale]]/`)}, so each page answers in every locale, and link with \`resolve(pathOf())\`: \`pathOf\` from ${color.path('#lib/locale')}, \`resolve\` from \`$app/paths\`.`,
        `A prerendered site lists every locale's pages in \`prerender.entries\`, built from \`LOCALES\`: ${color.website(EXAMPLE)}`,
      );
      if (language === 'ts') {
        steps.push('On Node, build on 22.18 or newer (23.6 on Node 23): Kit\'s build imports `src/params.ts` with the runtime itself, and Node strips types from those versions on.');
      }
    }
    if (routing === 'custom') {
      steps.push(report.stub
        ? `Fill \`event.locals.lang\` in the \`${report.stub}\` stub in ${color.path(`${directory.src}/hooks.server`)}, and keep the demo switcher's choice where it reads it.`
        : `Add a \`handle\` that fills \`event.locals.lang\` to ${color.path(`${directory.src}/hooks.server`)}, run before the i18n one, and keep the demo switcher's choice where it reads it.`);
    }

    return [...steps, ...report.notes];
  },
});
