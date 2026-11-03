import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

/** A Bifrost instance for plain Node, run as `node .vite/headless/headless.js`. */
export default defineConfig({
  build: {
    outDir: '.vite/headless',
    emptyOutDir: true,
    target: 'node24',
    minify: false,
    lib: { entry: 'src/main/headless.ts', formats: ['cjs'], fileName: () => 'headless.js' },
    rollupOptions: {
      // Native modules load from the node_modules of the machine the bundle runs on.
      external: (id) => id.startsWith('node:') || builtinModules.includes(id) || ['node-pty', '@parcel/watcher'].includes(id),
    },
  },
});
