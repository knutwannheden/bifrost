import { defineConfig, Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function copyMcpBridge(): Plugin {
  return {
    name: 'copy-mcp-bridge',
    writeBundle(options) {
      const outDir = options.dir || 'dist';
      const destDir = path.join(outDir, 'mcp-bridge');
      const src = path.resolve('src/main/mcp-bridge/bifrost-mcp.js');
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, 'bifrost-mcp.js'));
    },
  };
}

export default defineConfig({
  build: {
    rollupOptions: {
      external: ['node-pty'],
    },
  },
  plugins: [copyMcpBridge()],
});
