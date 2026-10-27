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
      const source = path.resolve(import.meta.dirname, nativeEditorOutDir, 'editor.html');
      for (const target of stagedEditorTargets) {
        const output = path.resolve(import.meta.dirname, target);
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
    // ES2020 (optional chaining/nullish coalescing) sets the editor's WebView
    // SYNTAX floor at Chromium 80. Non-updated Android System WebViews below that
    // (down to Chromium 66 on stock Android 9/10) can't parse the bundle at all,
    // so editor.html's ES5 preflight compiles this syntax up front and the
    // Android shell shows an "update System WebView" screen instead of a blank
    // editor (github#8). Raising this target means widening that preflight's
    // probe.
    //
    // The target does NOT settle the floor on its own: a dependency calling a
    // built-in method that landed later parses fine here and throws on the
    // device. editor.html shims those (replaceAll, at) and
    // tests/editor-embed-webview-floor.spec.ts audits the BUILT bundle for any
    // that no shim covers.
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
