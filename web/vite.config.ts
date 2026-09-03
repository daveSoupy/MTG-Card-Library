import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Dev runs the UI here and proxies the API to the Fastify server, so the
    // browser sees one origin and there is no CORS layer to configure.
    proxy: {
      '/api': {
        target: process.env.MTG_API ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
