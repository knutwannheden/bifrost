import { app, BrowserWindow, Notification } from 'electron';
import { execFile } from 'node:child_process';

let mainWindow: BrowserWindow | null = null;

export function initNotificationService(window: BrowserWindow): void {
  mainWindow = window;
}

// Per-task debounce: suppress duplicate notifications within 10s
const lastNotification = new Map<string, number>();

export function isDebounced(taskId: string): boolean {
  const now = Date.now();
  const last = lastNotification.get(taskId) ?? 0;
  return now - last < 10_000;
}

export function markNotified(taskId: string): void {
  lastNotification.set(taskId, Date.now());
}

/** Bell-triggered notification (instant, from xterm.js BEL/OSC). */
export function handleBellNotification(taskId: string, taskName: string, isActiveTask: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const focused = mainWindow.isFocused();

  // Skip entirely if the user is focused on this task
  if (focused && isActiveTask) return;

  // Sound for background tasks or when unfocused
  execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});

  // OS notification + dock bounce only when window is not focused
  if (!focused) {
    new Notification({ title: taskName, body: 'Waiting for input' }).show();
    app.dock?.bounce('informational');
  }
}
