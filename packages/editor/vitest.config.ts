import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // The conformance test pulls image rules from the sibling package
      // (filename/tags live here in @futo-notes/editor; image stays in shared).
      '@futo-notes/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
});
