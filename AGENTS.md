# AGENTS.md

Behavioral guidelines for LLM coding assistants working on
**`@sveltekit-i18n/sv`**. Applies to anything that drives commits, PRs, or
file edits on this repo.

**Precedence:** These repo rules override individual LLM memory or personal
preference. If your own memory conflicts with this file, follow this file.

This repo follows the same working rules as
[`base`'s AGENTS.md](https://github.com/sveltekit-i18n/base/blob/master/AGENTS.md)
(sections 1-14: think before coding, simplicity first, surgical changes,
verify and review cycle with release planning, commit on approval, fixup
hygiene, branch & push discipline, PRs, docs track code, coding conventions,
security posture, English-only artifacts, test rules, terse output, no
emojis). What follows is only what differs here.

Those rules are not in this file, and nothing loads them for you: before any
change, read base's AGENTS.md in full — `../base/AGENTS.md` when `base` is
checked out beside this repository on an up-to-date `master`, otherwise
[the raw file](https://raw.githubusercontent.com/sveltekit-i18n/base/master/AGENTS.md)
— and follow it as fully as the rules below.

---

## The package

A [Svelte CLI](https://svelte.dev/docs/cli) add-on: `npx sv add
@sveltekit-i18n` sets sveltekit-i18n up in a SvelteKit 3 project, as
[lib#295](https://github.com/sveltekit-i18n/lib/issues/295) set out. It is
build-time tooling that `sv` imports and runs once, so it ships nothing to an
app's runtime and keeps its own release cadence.

Stack: npm with `package-lock.json`, TypeScript ESM, tsup, Vitest with
`sv/testing` and Playwright, ESLint 10 flat config, Node 22+. The suite's
generated projects install with pnpm, as `sv/testing` does.

Issues for this repo live in the `lib` tracker.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | tsup → `dist/index.js` |
| `npm test` | the whole suite (runs `build` and `typecheck` first); needs pnpm and Playwright's Chromium (`CHROMIUM_PATH` names another build) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint --fix .` (also the pre-commit hook) |
| `npm run demo-create` / `npm run demo-add` | scaffold `demo/` with `sv create`, then run the built add-on on it, to try it by hand |

## Repository map

| Path | Role |
|------|------|
| `src/index.ts` | the add-on: `setup`, `run` (every check that can cancel, then the writes) and `nextSteps` |
| `src/options.ts` | the options `sv` asks for, and `readOptions`, which reads them again in `run()` |
| `src/packages.ts` | the formats and the extensions, and the range of each package, read off this package's devDependencies |
| `src/generate.ts` | the files the add-on creates: `$lib/i18n`, `$lib/locale`, `params`, the messages and the demo page |
| `src/hooks.ts`, `src/load.ts`, `src/layout.ts`, `src/params.ts`, `src/demo.ts` | the transforms that merge into a file the project has already |
| `src/ast.ts` | what those transforms share: finding an export, unexporting it, `UNPARSED` |
| `src/base.ts` | reads `kit.paths.base` off the Kit config |
| `src/locales.ts` | parses and canonicalizes the `locales` option |
| `tests/unit/` | the transforms and the options, in process |
| `tests/run/` | `add()` over a project that cancels or skips a file, without an install |
| `tests/cli/` | the `sv` command line over the built package |
| `tests/addon/` | the matrix: each option set on `kit-js` and `kit-ts`, installed, built, checked and served |
| `tests/merge/` | a project with its own `handle`, loads and `params`, and a second run |
| `tests/setup/` | the global setup, `setupTest` and the helpers the suites share |

## Architecture you must respect

- **One self-contained bundle, `sv` external.** `sv` installs no
  `dependencies` of an add-on, so `dependencies` stays empty and everything
  else (`@sveltejs/sv-utils`, the locale parsing) is bundled. `sv` is the one
  peer.
- **The add-on never imports what it installs.** It adds a package with
  `sv.dependency(name, range)` (`devDependency` for typegen). Each package it
  installs is a devDependency here, which the suite runs against, and the
  range it writes is that devDependency's, read at build time: there is no
  version constant in the source.
- **Every write goes through `sv.file()`** with the transforms of
  `@sveltejs/sv-utils`; no `fs` write and no regex edit of JS.
- **Every check that can cancel runs before the first write.** `cancel()`
  undoes nothing `sv.file()` wrote. The dependencies are written last, so a
  run that stops early leaves a project a later run still sets up.
- **Options are read again in `run()`.** The command line and `add()` skip
  `validate` and hand the values on as typed.
- **A file that does not parse, or has a shape the add-on does not merge
  into, is left alone, never fatal.** Every transform of a user file passes
  `onError` and records a step. `nextSteps` sees only the options, so `run()`
  keeps its notes in a list it resets as it starts.
- **A second run changes nothing.** Every transform checks for what it adds
  before adding it.
- **`setup` refuses a project without SvelteKit, or below SvelteKit 3**, and
  `run()` checks again, since `add()` skips `unsupported`.
- **The hooks transform is the add-on's own**, not `js.kit.addHooksHandle`,
  which breaks a `handle` built with `sequence()`, a handle exported by
  specifier and a re-exported one.
- **Nothing the app names is renamed but its own `load`.** A global rename
  meets type members, qualifiers and scopes `sv-utils` does not tell apart:
  the app's `handle` keeps its name and the sequence is exported as `handle`
  by specifier, and the app's `load` declaration alone takes a new name, the
  new `export const load` appended at the end of the module, where a reference
  inside a function now meets that one. A module that reads `load` as it is
  evaluated, which would meet it uninitialized, is left alone, and so is a
  `load` declared with `let` or `var`, which the module may assign to, or
  overloaded. A new name is checked against the module's imports too, which
  `js.identifiers.freeName` misses.
- **The hooks and load transforms append the statements they add.** esrap
  places a module's comments by their positions, so a statement inserted
  between two others takes comments that are not its own; an appended one
  only follows the module's last comments.
- **An existing layout `load` keeps its data typed.** Kit infers a layout's
  data from the exported `load` alone, so the app's own one, renamed and
  called by the wrapper, carries its type as `satisfies` rather than as an
  annotation, which would erase what it returns from every page's `data`. In
  JavaScript the type goes in a JSDoc `@satisfies` of its own, after the
  JSDoc the `load` has, since TypeScript reads the last one alone. A JSDoc
  whose single tag is `@type {…}` or `@satisfies {…}`, where TypeScript
  always starts a tag, carries it itself instead. A `load` is left alone
  whose JSDoc lies between `export` and the function, or holds `@param`,
  `@returns`, `@template` or `@this`, which the JSDoc after it would hide.
  It looks for these four anywhere, so one the text merely mentions leaves
  the `load` alone too.
- **The generated code follows `lib`'s README Quick Start** of the current
  version, except where lib#295 says otherwise. A change there is a change
  here, in the same release plan.

## Tests

- The matrix and the merge suite build real apps: `sv/testing` copies a
  template per case, runs the add-on, installs with pnpm, and the test builds,
  runs `svelte-check` and serves the app to Chromium through `serve()`, which
  fails a case on an error the page throws or logs. Not `sv`'s
  `prepareServer`: it runs the preview through pnpm, stops that after a
  minute and leaves Vite running.
- Cases run concurrently, so a test reads `expect` off its context, and a
  helper that runs a command never blocks the event loop.
- A transform's output is pinned by an inline snapshot in
  `tests/unit/transforms.test.ts`, which runs the transform again on it and
  expects no change.

## Releases

A release is planned with the rest of the family (base's §4, *Releases*),
last: after every package it installs, `sveltekit-i18n` included. A release
of one of those is a release of this package, whose devDependencies move to
it first. `README.md` is the npm page, so it describes the version being
published, and each of its links resolves.

The benchmark and `publish.yml` come in a pull request of their own, before
the first publish. That first version, `1.0.0-next.0`, is published by hand
(`npm publish --tag next`), as npm configures trusted publishing only for a
package that exists; every later release runs `publish.yml`.

## Comments

If you need a paragraph-long comment to justify why the workaround is OK,
the code is wrong — fix the code.
