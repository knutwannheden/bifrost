import path from 'node:path';
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { IPC_STREAM } from '../shared/ipc-channels';
import { resolveKeymap, serializeBinding } from '../shared/keymap';
import { stopAllWatching } from './activity-watcher';
import { initApi, startApi, stopApi } from './bifrost-api';
import { loadConfig } from './config';
import { closeDatabase, openDatabase } from './db';
import { ensureHooks } from './integration-installer';
import { registerIpcHandlers } from './ipc-handlers';
import { initNotificationService } from './notification-service';
import { killAllSessions } from './session-manager';
import { startPolling } from './slack-service';

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
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : { autoHideMenuBar: true }),
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Open external links in the system browser instead of Electron windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {
      /* ignore */
    });
    return { action: 'deny' };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
};

let lastQuitAttempt = 0;
const DOUBLE_TAP_MS = 500;

function toElectronAccelerator(serialized: string): string {
  return serialized.replace(/Cmd/g, 'CommandOrControl');
}

function buildMenu() {
  const sendAction = (action: string) => {
    mainWindow?.webContents.send(IPC_STREAM.MENU_ACTION, action);
  };

  const config = loadConfig();
  const keymap = resolveKeymap(config.keybindings);
  const accelFor = (actionId: string): string | undefined => {
    const binding = keymap.find((b) => b.actionId === actionId);
    return binding ? toElectronAccelerator(serializeBinding(binding.strokes)) : undefined;
  };

  const isMac = process.platform === 'darwin';
  const template: Electron.MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              {
                label: 'Quit Bifrost',
                accelerator: 'CommandOrControl+Q',
                click: () => {
                  const now = Date.now();
                  if (now - lastQuitAttempt < DOUBLE_TAP_MS) {
                    app.quit();
                  } else {
                    lastQuitAttempt = now;
                    mainWindow?.webContents.send(IPC_STREAM.MENU_ACTION, 'quit-confirm');
                  }
                },
              },
            ],
          },
        ]
      : []),
    // File
    {
      label: 'File',
      submenu: [
        {
          label: 'New Task',
          accelerator: accelFor('task.new'),
          registerAccelerator: false,
          click: () => sendAction('new-task'),
        },
        {
          label: 'Close Pane',
          accelerator: accelFor('task.close'),
          registerAccelerator: false,
          click: () => sendAction('close-pane'),
        },
        {
          label: 'Archive Task',
          accelerator: accelFor('task.archive'),
          registerAccelerator: false,
          click: () => sendAction('archive-task'),
        },
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
        {
          label: 'Toggle Dev Terminal',
          accelerator: accelFor('view.devTerminal'),
          registerAccelerator: false,
          click: () => sendAction('toggle-dev-terminal'),
        },
        { type: 'separator' },
        {
          label: 'Diff',
          accelerator: accelFor('view.diff'),
          registerAccelerator: false,
          click: () => sendAction('diff'),
        },
        {
          label: 'Task History',
          accelerator: accelFor('view.history'),
          registerAccelerator: false,
          click: () => sendAction('task-history'),
        },
        {
          label: 'Repositories',
          accelerator: accelFor('view.repos'),
          registerAccelerator: false,
          click: () => sendAction('repositories'),
        },
        {
          label: 'Review',
          accelerator: accelFor('view.review'),
          registerAccelerator: false,
          click: () => sendAction('review'),
        },
        { type: 'separator' },
        {
          label: 'Open in IDE',
          accelerator: accelFor('action.openIde'),
          registerAccelerator: false,
          click: () => sendAction('open-in-ide'),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    // Window
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : [{ role: 'close' as const }]),
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

  // Ensure plugin hooks are in the path Claude actually loads from
  ensureHooks();

  // Start HTTP API
  await startApi();

  // Open DuckDB before registering handlers (stores depend on it)
  await openDatabase();

  if (mainWindow) {
    await registerIpcHandlers(mainWindow);
    initNotificationService(mainWindow);
    initApi(mainWindow);
    startPolling(mainWindow);
  }

  globalShortcut.register('CommandOrControl+Shift+B', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('before-quit', async () => {
  stopAllWatching();
  killAllSessions();
  await stopApi();
  closeDatabase();
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
