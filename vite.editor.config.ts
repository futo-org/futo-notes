// Standalone Milkdown bundle for desktop-compatible browser tests and benchmarks.
// Mobile apps render the Rust Linedown engine directly and never stage this bundle.
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';

const nativeEditorOutDir = 'build/native-editor';
export default defineConfig({
  plugins: [tailwindcss(), svelte(), viteSingleFile()],
  root: '.',
  base: './',
  build: {
    // Keep the standalone fixture's browser syntax floor and built-in shims stable.
    // tests/editor-embed-webview-floor.spec.ts audits the built bundle.
    target: 'es2020',
    outDir: nativeEditorOutDir,
    sourcemap: false,
    // Inline everything: a single self-contained HTML file is the goal, so
    // raise the warning ceiling and let singlefile fold all assets in.
    chunkSizeWarningLimit: 100000,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rolldownOptions: {
      input: path.resolve(import.meta.dirname, 'editor.html'),
      // The native debug recipes build with VITE_INCLUDE_TEST_HOOKS=true, which puts
      // the puppet inspector (src/app/puppet) in; its trace names handlers by
      // function name, which minification would otherwise turn into `Id`.
      output: { keepNames: process.env.VITE_INCLUDE_TEST_HOOKS === 'true' },
    },
  },
  resolve: {
    alias: {
      $lib: path.resolve(import.meta.dirname, './src/lib'),
      $app: path.resolve(import.meta.dirname, './src/app'),
      $features: path.resolve(import.meta.dirname, './src/features'),
      $shared: path.resolve(import.meta.dirname, './src/shared'),
      '@': path.resolve(import.meta.dirname, './'),
      '/src': path.resolve(import.meta.dirname, './src'),
      '@futo-notes/editor': path.resolve(import.meta.dirname, './packages/editor/src'),
    },
  },
});
