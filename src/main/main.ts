import { app, BrowserWindow, globalShortcut, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc-handlers';
import { killAllSessions } from './session-manager';
import { initNotificationService } from './notification-service';
import { startApi, stopApi } from './bifrost-api';

if (started) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

function installMcpServer(): void {
  const destDir = path.join(os.homedir(), '.bifrost', 'mcp');
  const srcDir = path.join(app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..', '..'), 'src', 'mcp-server');

  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Copy server.mjs and package.json
  for (const file of ['server.mjs', 'package.json']) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }

  // Install deps if node_modules is missing or package.json changed
  const destModules = path.join(destDir, 'node_modules');
  if (!fs.existsSync(destModules)) {
    try {
      execSync('npm install --production', { cwd: destDir, stdio: 'ignore', timeout: 30000 });
    } catch {
      // best-effort
    }
  }
}

app.on('ready', async () => {
  // Set dock icon on macOS (needed during development)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  createWindow();

  // Start HTTP API and install MCP server
  await startApi();
  installMcpServer();

  if (mainWindow) {
    registerIpcHandlers(mainWindow);
    initNotificationService(mainWindow);
  }

  globalShortcut.register('CommandOrControl+Shift+B', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', () => {
  killAllSessions();
  stopApi();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

export { mainWindow };
