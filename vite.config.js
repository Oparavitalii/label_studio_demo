import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // The label backend (Server/index.js) listens on 5180. In dev, Vite serves
  // the UI and forwards /api to it, so the frontend uses the same relative
  // URLs in dev as it does in production, where the backend serves dist/ itself.
  server: {
    proxy: {
      '/api': 'http://localhost:5180',
    },
  },

  // Asset handling
  assetsInclude: [
    '**/*.png',
    '**/*.jpg',
    '**/*.jpeg',
    '**/*.gif',
    '**/*.svg',
    '**/*.webp',
  ],

  build: {
    rollupOptions: {
      // Ensure images are handled properly
      external: [],
    },
  },
});
