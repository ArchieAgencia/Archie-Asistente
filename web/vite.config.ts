import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  build: { outDir: 'dist', sourcemap: false, assetsInlineLimit: 0 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:8800', '/auth': 'http://127.0.0.1:8800' } },
});
