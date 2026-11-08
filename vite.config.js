import { defineConfig } from 'vite';

// base './' keeps dist/ portable (sub-path hosting and file:// inspection)
export default defineConfig({
  base: './',
  build: { target: 'es2022', outDir: 'dist' },
  // Team rooms in development: run `npm run server` (port 8787) next to `npm run dev`.
  server: { proxy: { '/ws': { target: 'ws://127.0.0.1:8787', ws: true } } },
});
