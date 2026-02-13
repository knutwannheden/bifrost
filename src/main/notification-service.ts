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

export function scanOutputForNotifications(
  output: string,
): { title: string; body: string } | null {
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^(Task completed|Done)\b/i.test(trimmed)) {
      return { title: 'Task Completed', body: trimmed };
    }

    if (/\bError:/i.test(trimmed)) {
      return { title: 'Error Detected', body: trimmed };
    }

    if (/\b(waiting for input|Waiting for)\b/i.test(trimmed)) {
      return { title: 'Waiting for Input', body: trimmed };
    }
  }

  return null;
}
