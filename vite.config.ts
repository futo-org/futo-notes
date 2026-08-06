import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';
import { webPort } from './scripts/lib/slot.mjs';

// The CodeMirror packages the editor imports statically. Everything else under
// `@codemirror`/`@lezer` is a code-fence grammar reached only via
// `@codemirror/language-data`'s dynamic imports.
const CODEMIRROR_CORE = [
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language/',
  '@codemirror/commands',
  '@codemirror/autocomplete',
  '@codemirror/search',
  '@codemirror/lang-markdown',
  '@lezer/common',
  '@lezer/highlight',
  '@lezer/lr',
  '@lezer/markdown',
];

const IGNORED_WATCH_DIRS = [
  '.claude/worktrees',
  'target',
  'dist',
  '.tauri-data',
  'build',
  'playwright-report',
  'factory/captures',
  'apps/android/app/build',
  'apps/android/build',
  'apps/android/app/src/main/assets/editor.html',
  'apps/ios/.build',
  'apps/ios/.build-device',
  'apps/ios/.build-device-release',
  'apps/ios/Resources/editor.html',
].map((dir) => path.resolve(__dirname, dir).split(path.sep).join('/'));

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  root: '.',
  base: './',
  build: {
    target: 'ES2020',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // CodeMirror's editor core is isolated as its own chunk. Keep the warning
    // threshold above that known chunk so new unexpected growth still shows up
    // in the asset table without noisy CI warnings.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@codemirror') || id.includes('codemirror') || id.includes('@lezer')) {
            // Only the editor core is eager. `@codemirror/language-data`
            // reaches all ~128 code-fence grammars through its own `import()`
            // calls, so returning undefined lets Rollup give each one its own
            // chunk, fetched when a fence of that language first appears.
            //
            // Do NOT collapse those into one named chunk: `lang-markdown`
            // statically imports `lang-html` (which pulls css + javascript),
            // so a single grammar chunk contains statically-reachable modules
            // and Rollup correctly makes the whole thing eager again — putting
            // all 128 grammars back on the cold-start path. Measured: naming
            // them costs 1,027,178 raw / 357,724 gzip of extra startup work.
            return CODEMIRROR_CORE.some((pkg) => id.includes(pkg)) ? 'codemirror' : undefined;
          }
          if (id.includes('node_modules/svelte')) {
            return 'svelte';
          }
          if (id.includes('@tauri-apps')) {
            return 'tauri-vendor';
          }
        },
      },
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
  server: {
    // strictPort: vite's fallback lands on port+1 — another worktree's port —
    // while every consumer still points at the original.
    port: webPort(),
    strictPort: true,
    watch: {
      // Vite does not read .gitignore. A predicate, not globs: these paths are
      // absolute and unescaped glob metacharacters in a checkout path silently
      // match nothing.
      ignored: (file) => {
        const p = file.split(path.sep).join('/');
        return IGNORED_WATCH_DIRS.some((dir) => p === dir || p.startsWith(`${dir}/`));
      },
    },
    // Dev only. The Tauri WebKitGTK webview heuristically disk-caches module
    // responses across app restarts. After a dev-server restart the cached
    // parent-component JS executes without a server hit and imports its
    // `?svelte&type=style&lang.css` virtual module BEFORE the fresh server
    // has compiled the component — vite-plugin-svelte then has no compiled
    // style, vite falls back to the raw .svelte file, and Tailwind's CSS
    // transform errors on the <script> block ("Invalid declaration"). Serving
    // everything no-store forces the webview to re-fetch parents first, so
    // the compile cache is always populated in dependency order.
    headers: { 'Cache-Control': 'no-store' },
  },
});
