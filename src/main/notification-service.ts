import { BrowserWindow, Notification } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';

let mainWindow: BrowserWindow | null = null;

export function initNotificationService(window: BrowserWindow): void {
  mainWindow = window;
}

export function sendNotification(title: string, body: string): void {
  if (mainWindow && !mainWindow.isFocused()) {
    new Notification({ title, body }).show();
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.NOTIFICATION, title, body);
  }
}
