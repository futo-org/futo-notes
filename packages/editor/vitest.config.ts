import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
    // See vitest.config.ts (root) for why this is capped only under CI.
    maxWorkers: process.env.CI ? 4 : undefined,
  },
  resolve: {
    alias: {
      // The conformance test pulls image rules from the sibling package
      // (filename/tags live here in @futo-notes/editor; image stays in shared).
      '@futo-notes/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
