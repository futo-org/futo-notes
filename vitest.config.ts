import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'markdown-spec/**/*.test.ts', 'scripts/**/*.test.mjs'],
    mockReset: true,
    server: { deps: { inline: [/^svelte/] } },
    // Under CI, several test-stage jobs land on the same shared runner host
    // at once (each an uncapped container reporting the host's full core
    // count), so the default numCpus-1 workers oversubscribe the box and
    // starve tests into timeouts (PKT-20). Local dev keeps full parallelism.
    maxWorkers: process.env.CI ? 4 : undefined,
  },
  resolve: {
    // 'browser' picks svelte's index-client.js (where `mount` lives) for
    // jsdom-environment tests; without it tests pull the SSR build and
    // hit `mount(...) is not available on the server`.
    conditions: ['browser'],
    alias: {
      $lib: path.resolve(__dirname, './src/lib'),
      $features: path.resolve(__dirname, './src/features'),
      '@': path.resolve(__dirname, './'),
      '@futo-notes/shared': path.resolve(__dirname, './packages/shared/src'),
      '@futo-notes/editor': path.resolve(__dirname, './packages/editor/src'),
    },
  },
});
