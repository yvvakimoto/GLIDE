import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5273 },
  build: { target: 'es2022', assetsInlineLimit: 0 },
});
