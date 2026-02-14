import { app, BrowserWindow, globalShortcut, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

function installMcpBridge(): void {
  const destDir = path.join(os.homedir(), '.bifrost', 'bin');
  const destFile = path.join(destDir, 'bifrost-mcp.js');
  const srcFile = path.join(__dirname, 'mcp-bridge', 'bifrost-mcp.js');

  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  if (fs.existsSync(srcFile)) {
    fs.copyFileSync(srcFile, destFile);
  }
}

app.on('ready', async () => {
  // Set dock icon on macOS (needed during development)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  createWindow();

  // Start HTTP API for MCP bridge
  await startApi();

  // Install MCP bridge script to ~/.bifrost/bin/
  installMcpBridge();

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
