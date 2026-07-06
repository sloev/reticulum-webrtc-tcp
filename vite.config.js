import { defineConfig } from 'vite';

export default defineConfig({
  root: 'browser',
  build: {
    outDir: '../dist',
    emptyOutDir: true
  },
  resolve: {
    alias: {
      crypto: 'crypto-browserify',
      stream: 'stream-browserify',
      vm: 'vm-browserify',
      process: 'process/browser',
      buffer: 'buffer',
      events: 'events',
      util: 'util',
      string_decoder: 'string_decoder',
    }
  },
  // bzip2-wasm's Emscripten-generated glue code resolves its .wasm file
  // relative to its own script location; Vite's dev-server dependency
  // pre-bundling (esbuild) rewrites/caches that script somewhere the
  // relative path no longer resolves, so excluding it from pre-bundling
  // (it's still bundled normally for production builds via Rollup, which
  // handles the .wasm asset correctly) keeps `npm run dev` working too.
  optimizeDeps: {
    exclude: ['bzip2-wasm'],
  },
  define: {
    'process.env': {},
    'global': 'window',
  }
});
