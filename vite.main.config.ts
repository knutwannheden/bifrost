import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty', 'better-sqlite3', '@parcel/watcher'],
    },
  },
});
