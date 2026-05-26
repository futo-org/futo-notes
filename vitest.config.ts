import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'markdown-spec/**/*.test.ts'],
    mockReset: true,
    server: { deps: { inline: [/^svelte/] } },
  },
  resolve: {
    // 'browser' picks svelte's index-client.js (where `mount` lives) for
    // jsdom-environment tests; without it tests pull the SSR build and
    // hit `mount(...) is not available on the server`.
    conditions: ['browser'],
    alias: {
      '$lib': path.resolve(__dirname, './src/lib'),
      '@': path.resolve(__dirname, './'),
      '@futo-notes/shared': path.resolve(__dirname, './packages/shared/src'),
    },
  },
});
