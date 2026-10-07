import { defineConfig } from 'tsup';

export default defineConfig(
  /** @type {() => import('tsup').Options} */
  (options) => ({
    clean: true,
    format: ['esm'],
    entry: ['src/index.ts'],
    // `sv` imports the add-on and installs none of its dependencies, so
    // everything it needs is bundled into the one file — except `sv` itself,
    // which is the peer that loads it.
    external: ['sv'],
    noExternal: [/^(?!sv$)/],
    minify: !options.watch,
    sourcemap: options.watch,
  }),
);
