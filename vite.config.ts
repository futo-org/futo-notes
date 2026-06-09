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
        }
      }
    }
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
  server: {
    port: 5173,
    strictPort: false
  }
});
