import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The analyzer walks a real fixture project from disk, so a cold run is
    // slower than a unit test but still well under a second per file.
    testTimeout: 30_000,
    setupFiles: ['tests/setup.ts'],
    reporters: 'default',
  },
});
