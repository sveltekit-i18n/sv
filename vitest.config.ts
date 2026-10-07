import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Prepares the project templates every suite copies its cases from.
    globalSetup: ['tests/setup/global.ts'],
    // A suite installs, builds and serves real SvelteKit apps.
    testTimeout: 180_000,
    hookTimeout: 600_000,
    expect: { requireAssertions: true },
  },
});
