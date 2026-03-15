import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty', '@duckdb/node-api', '@duckdb/node-bindings'],
    },
  },
});
