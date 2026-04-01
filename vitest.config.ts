import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'markdown-spec/**/*.test.ts'],
    mockReset: true,
  },
  resolve: {
    alias: {
      '$lib': path.resolve(__dirname, './src/lib'),
      '@': path.resolve(__dirname, './'),
      '@futo-notes/shared': path.resolve(__dirname, './packages/shared/src'),
    },
  },
});
