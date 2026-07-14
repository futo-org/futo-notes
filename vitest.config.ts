import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

const nodeDefinesWebStorage =
  Object.getOwnPropertyDescriptor(globalThis, 'localStorage') !== undefined;

export default defineConfig({
  plugins: [svelte({ hot: false })],
  test: {
    globals: true,
    include: ['src/**/*.test.ts', 'markdown-spec/**/*.test.ts', 'scripts/**/*.test.mjs'],
    mockReset: true,
    // Newer Node releases install an experimental localStorage getter that
    // shadows jsdom and returns undefined without --localstorage-file. Disable
    // only that Node-owned global in workers so jsdom can install its storage.
    execArgv: nodeDefinesWebStorage ? ['--no-experimental-webstorage'] : [],
    environmentOptions: {
      // Give jsdom a non-opaque origin so Web Storage exists consistently.
      // Node 26 exposes its own disabled localStorage global unless launched
      // with --localstorage-file; an explicit jsdom URL keeps tests bound to
      // the browser-compatible implementation instead.
      jsdom: { url: 'http://localhost/' },
    },
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
      $app: path.resolve(__dirname, './src/app'),
      $features: path.resolve(__dirname, './src/features'),
      $shared: path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './'),
      '@futo-notes/editor': path.resolve(__dirname, './packages/editor/src'),
    },
  },
});
