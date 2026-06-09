// Vite config for the native-iOS spike's embedded editor bundle.
//
// Builds editor.html as a SINGLE self-contained HTML file (all JS inlined as
// <script>, all CSS as <style>, fonts/assets inlined) so the Swift host can
// `loadHTMLString` it without hitting WKWebView file:// / module-loading
// restrictions. Output lands in apps/ios/Resources/editor.html.
//
// Mirrors vite.config.ts but adds viteSingleFile() and points the single
// rollup input at editor.html with a non-emptying outDir.

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), svelte(), viteSingleFile()],
  root: '.',
  base: './',
  build: {
    target: 'ES2020',
    outDir: 'apps/ios/Resources',
    // Resources dir holds other (native) files — never wipe it.
    emptyOutDir: false,
    sourcemap: false,
    // Inline everything: a single self-contained HTML file is the goal, so
    // raise the warning ceiling and let singlefile fold all assets in.
    chunkSizeWarningLimit: 100000,
    assetsInlineLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      input: path.resolve(__dirname, 'editor.html'),
    },
  },
  resolve: {
    alias: {
      '$lib': path.resolve(__dirname, './src/lib'),
      '@': path.resolve(__dirname, './'),
      '/src': path.resolve(__dirname, './src'),
      '@futo-notes/shared': path.resolve(__dirname, './packages/shared/src'),
      '@futo-notes/editor': path.resolve(__dirname, './packages/editor/src'),
    },
  },
});
