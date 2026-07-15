// Vite config for the shared native embedded editor bundle.
//
// Builds editor.html as a SINGLE self-contained HTML file (all JS inlined as
// <script>, all CSS as <style>, fonts/assets inlined) so the native WebView
// hosts can load one local file without module-loading or asset path issues.
// Output lands in build/native-editor/editor.html and is staged into the iOS
// resources + Android assets expected by the native shells.
//
// Mirrors vite.config.ts but adds viteSingleFile(), points the single rollup
// input at editor.html, and stages the built file into the native shells.

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { viteSingleFile } from 'vite-plugin-singlefile';
import path from 'path';
import { copyFileSync, mkdirSync } from 'node:fs';

const nativeEditorOutDir = 'build/native-editor';
const stagedEditorTargets = [
  'apps/ios/Resources/editor.html',
  'apps/android/app/src/main/assets/editor.html',
];

function stageNativeEditorBundle() {
  return {
    name: 'stage-native-editor-bundle',
    closeBundle() {
      const source = path.resolve(__dirname, nativeEditorOutDir, 'editor.html');
      for (const target of stagedEditorTargets) {
        const output = path.resolve(__dirname, target);
        mkdirSync(path.dirname(output), { recursive: true });
        copyFileSync(source, output);
      }
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), svelte(), viteSingleFile(), stageNativeEditorBundle()],
  root: '.',
  base: './',
  build: {
    target: 'ES2020',
    outDir: nativeEditorOutDir,
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
      $lib: path.resolve(__dirname, './src/lib'),
      $app: path.resolve(__dirname, './src/app'),
      $features: path.resolve(__dirname, './src/features'),
      $shared: path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './'),
      '/src': path.resolve(__dirname, './src'),
      '@futo-notes/editor': path.resolve(__dirname, './packages/editor/src'),
    },
  },
});
