import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/benchmark.ts'],
  format: ['esm'],
  outDir: 'dist',
  external: ['better-sqlite3', 'argon2'],
  noExternal: ['@futo-notes/shared'],
  clean: true,
});
