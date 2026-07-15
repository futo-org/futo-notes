import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // See vitest.config.ts (root) for why this is capped only under CI.
    maxWorkers: process.env.CI ? 4 : undefined,
  },
});
