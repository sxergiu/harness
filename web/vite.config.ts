import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
// Resolved through the workspace symlink rather than the alias below — a config
// cannot use the aliases it is defining.
import { DEV_PAGE_PORT } from '@harness/shared';

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
