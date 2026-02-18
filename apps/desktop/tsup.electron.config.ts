import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { main: 'electron/main.ts' },
    format: ['cjs'],
    outDir: 'dist-electron',
    platform: 'node',
    target: 'node20',
    external: ['electron'],
    clean: true,
  },
  {
    entry: { preload: 'electron/preload.ts' },
    format: ['cjs'],
    outDir: 'dist-electron',
    platform: 'node',
    target: 'node20',
    external: ['electron'],
  },
]);
