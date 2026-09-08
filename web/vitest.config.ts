import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Separate from vite.config.ts's dev/build setup: this only runs the DOM
// smoke tests (src/**/*.test.tsx). The pure-logic tests (src/**/*.test.ts)
// stay on plain `node --test`, which needs no browser environment.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    include: ['src/**/*.test.tsx'],
  },
});
