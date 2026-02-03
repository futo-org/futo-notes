import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: 'public',
  build: {
    target: 'ES2020',
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: false
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      '/src': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false
  }
});
