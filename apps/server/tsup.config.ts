import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  external: ['better-sqlite3', 'argon2'],
  clean: true,
});
