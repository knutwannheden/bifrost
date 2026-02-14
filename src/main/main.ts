import { app, BrowserWindow, globalShortcut, Menu, nativeImage, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import started from 'electron-squirrel-startup';
import { registerIpcHandlers } from './ipc-handlers';
import { killAllSessions } from './session-manager';
import { initNotificationService } from './notification-service';
import { startApi, stopApi } from './bifrost-api';
import { IPC_STREAM } from '../shared/ipc-channels';

if (started) {
  app.quit();
}

app.name = 'Bifrost';

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#282a36',
    titleBarStyle: 'hiddenInset',
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the system browser instead of Electron windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => { /* ignore */ });
    return { action: 'deny' };
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
  try {
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
      execSync('npm install --production', { cwd: destDir, stdio: 'ignore', timeout: 30000 });
    }
  } catch {
    // Best-effort — MCP server is optional
  }
}

function buildMenu() {
  const sendAction = (action: string) => {
    mainWindow?.webContents.send(IPC_STREAM.MENU_ACTION, action);
  };

  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    // File
    {
      label: 'File',
      submenu: [
        { label: 'New Task', accelerator: 'CommandOrControl+T', registerAccelerator: false, click: () => sendAction('new-task') },
        { label: 'Close Pane', accelerator: 'CommandOrControl+W', registerAccelerator: false, click: () => sendAction('close-pane') },
      ],
    },
    // Edit
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    // View
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Dev Terminal', accelerator: 'CommandOrControl+/', registerAccelerator: false, click: () => sendAction('toggle-dev-terminal') },
        { type: 'separator' },
        { label: 'Diff', accelerator: 'CommandOrControl+D', registerAccelerator: false, click: () => sendAction('diff') },
        { label: 'Task History', accelerator: 'CommandOrControl+H', registerAccelerator: false, click: () => sendAction('task-history') },
        { label: 'Repositories', accelerator: 'CommandOrControl+R', registerAccelerator: false, click: () => sendAction('repositories') },
        { type: 'separator' },
        { label: 'Open in IDE', accelerator: 'CommandOrControl+O', registerAccelerator: false, click: () => sendAction('open-in-ide') },
      ],
    },
    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' as const },
          { role: 'front' as const },
        ] : [
          { role: 'close' as const },
        ]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on('ready', async () => {
  // Set dock icon on macOS (needed during development)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = path.join(__dirname, '../../assets/icon.png');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }

  buildMenu();
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
