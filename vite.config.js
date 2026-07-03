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
  define: {
    'process.env': {},
    'global': 'window',
  }
});
