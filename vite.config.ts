import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'path';

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  root: '.',
  base: './',
  build: {
    target: 'ES2020',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // CodeMirror is intentionally isolated as its own large editor chunk.
    // Keep the warning threshold above that known chunk so new unexpected
    // growth still shows up in the asset table without noisy CI warnings.
    chunkSizeWarningLimit: 1700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('@codemirror') || id.includes('codemirror') || id.includes('@lezer')) {
            return 'codemirror';
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
      $features: path.resolve(__dirname, './src/features'),
      '@': path.resolve(__dirname, './'),
      '/src': path.resolve(__dirname, './src'),
      '@futo-notes/editor': path.resolve(__dirname, './packages/editor/src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
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
