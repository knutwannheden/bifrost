import path from 'node:path';
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, screen, shell } from 'electron';
import started from 'electron-squirrel-startup';
import { IPC_STREAM } from '../shared/ipc-channels';
import { resolveKeymap, serializeBinding } from '../shared/keymap';
import type { BifrostConfig } from '../shared/types';
import { stopAllWatching } from './activity-watcher';
import { initApi, startApi, stopApi } from './bifrost-api';
import { loadConfig, saveConfig } from './config';
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

function setZoom(win: BrowserWindow | null | undefined, level: number): void {
  if (!win) return;
  win.webContents.setZoomLevel(level);
  win.webContents.send('zoom-changed', Math.round(100 * 1.2 ** level));
  const config = loadConfig();
  config.zoomLevel = level;
  saveConfig(config);
}

const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
/** How much of the window a display must cover for the position to be reachable. */
const ON_SCREEN_MARGIN = 100;

type WindowBounds = NonNullable<BifrostConfig['windowBounds']>;

/**
 * Saved bounds survive a display being unplugged or rearranged, so they are
 * only reused while some display still shows enough of the window to grab.
 */
function reachable(bounds: WindowBounds | undefined): WindowBounds | undefined {
  if (!bounds) return undefined;
  const visible = screen.getAllDisplays().some(({ workArea: a }) => {
    const overlapX = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const overlapY = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    return overlapX >= ON_SCREEN_MARGIN && overlapY >= ON_SCREEN_MARGIN;
  });
  if (!visible) return undefined;
  return { ...bounds, width: Math.max(bounds.width, MIN_WIDTH), height: Math.max(bounds.height, MIN_HEIGHT) };
}

let boundsTimer: ReturnType<typeof setTimeout> | null = null;

function rememberBounds(win: BrowserWindow): void {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  const config = loadConfig();
  // getNormalBounds is the un-maximized rectangle, so restoring down after a
  // restart puts the window back where it was before it was maximized.
  config.windowBounds = win.getNormalBounds();
  config.windowMaximized = win.isMaximized();
  saveConfig(config);
}

function rememberBoundsSoon(win: BrowserWindow): void {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    boundsTimer = null;
    rememberBounds(win);
  }, 500);
}

const createWindow = () => {
  const saved = loadConfig();
  const bounds = reachable(saved.windowBounds);
  mainWindow = new BrowserWindow({
    ...(bounds ?? { width: 1200, height: 800 }),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
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

  if (saved.windowMaximized) mainWindow.maximize();

  const win = mainWindow;
  win.on('resized', () => rememberBoundsSoon(win));
  win.on('moved', () => rememberBoundsSoon(win));
  win.on('maximize', () => rememberBounds(win));
  win.on('unmaximize', () => rememberBounds(win));
  win.on('close', () => rememberBounds(win));

  // Restore saved zoom level
  if (saved.zoomLevel) mainWindow.webContents.setZoomLevel(saved.zoomLevel);

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
              { role: 'hide' as const, registerAccelerator: false },
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
        {
          label: 'Zoom In',
          accelerator: 'CommandOrControl+Shift+=',
          click: (_mi, win) => setZoom(win, (win?.webContents.getZoomLevel() ?? 0) + 0.5),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+Shift+-',
          click: (_mi, win) => setZoom(win, (win?.webContents.getZoomLevel() ?? 0) - 0.5),
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CommandOrControl+0',
          click: (_mi, win) => setZoom(win, 0),
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

  // Open SQLite DB before registering handlers (stores depend on it)
  openDatabase();

  if (mainWindow) {
    registerIpcHandlers(mainWindow);
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
