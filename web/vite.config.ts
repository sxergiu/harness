import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
// A config cannot use the aliases it is defining, and this one must be RELATIVE
// as well: Vite bundles a relative import into the config it loads, but leaves a
// BARE one external for node to import itself — and what node gets handed is a
// `.ts` file, which it can only parse from 22.6 on. As `@harness/shared` this
// built on a newer node and failed CI at the floor package.json declares.
import { DEV_PAGE_PORT } from '../shared/src/index.js';

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@harness/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    // Beside the bundled server rather than under web/, so that `dist/` is the
    // whole shippable thing and the server finds the page at one path in both
    // the repo and an installed copy.
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    // Local-only, matching the backend. Never expose this.
    host: '127.0.0.1',
    port: DEV_PAGE_PORT,
    proxy: {
      '/api': 'http://127.0.0.1:4373',
      '/ws': { target: 'ws://127.0.0.1:4373', ws: true },
    },
  },
});
