import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const backend = process.env.VITE_DEV_BACKEND ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/health': backend,
      '/socket.io': { target: backend, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
