import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // GitHub Actions sets BASE_PATH to './' for a project site or '/' for a user site.
  base: process.env.BASE_PATH || '/',
  define: { __BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@supabase/')) return 'supabase';
          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
        },
      },
    },
  },
});
