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
    // The browser floor, stated rather than inherited. Without this it is
    // whatever the installed Vite major happens to default to — 6 ships
    // 'baseline-widely-available', which is Safari 16 / Chrome 107 and moves
    // under us on an upgrade. These four are the real floor: mid-2021, set by
    // Array.prototype.at() in contention.ts, CollectionValuePanel and
    // FilterPanel, the newest API the client uses. The CSS floor used to be
    // stricter than the JS one (color-mix() is Chrome 111 / Safari 16.2);
    // styles.css now carries a plain declaration before every color-mix(), so
    // the two agree.
    target: ['chrome92', 'edge92', 'firefox90', 'safari15.4'],
    cssTarget: ['chrome92', 'edge92', 'firefox90', 'safari15.4'],
    // No sourcemap in the production build. It was 2,036,556 bytes — four times
    // the app itself — and @fastify/static's wildcard served it publicly, so it
    // shipped in the Docker image and both Electron bundles for no one's benefit.
    // Set this true locally when you actually need to debug a built bundle.
    sourcemap: false,
  },
});
