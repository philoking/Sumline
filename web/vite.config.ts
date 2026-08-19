import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API runs separately; in production the server serves
    // these assets itself and no proxy is involved.
    proxy: {
      '/api': {
        target: process.env['API_URL'] ?? 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    // No source map in the built bundle. It was six megabytes — several times
    // the bundle it describes — and every one of them sits in the runtime
    // image. Nothing is lost by leaving it out: `npm run dev` serves original
    // sources through esbuild regardless of this setting, so the map only ever
    // helped someone opening devtools against a deployed instance, and the
    // sources it would have shown them are in this repository.
    sourcemap: false,
  },
});
