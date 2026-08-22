import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8085',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['hls.js', 'prop-types'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react-router-dom') ||
            id.includes('node_modules/prop-types') ||
            id.includes('node_modules/scheduler')
          ) return 'vendor';
          if (id.includes('node_modules/hls.js')) return 'hls';
          if (
            id.includes('node_modules/i18next') ||
            id.includes('node_modules/react-i18next')
          ) return 'i18n';
          if (
            id.includes('/src/contexts/') ||
            id.includes('/src/hooks/') ||
            id.includes('/src/components/')
          ) return 'shared';
        },
      },
    },
  },
});
