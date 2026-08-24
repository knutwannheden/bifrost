import { execFile } from 'node:child_process';
import path from 'node:path';
import { app, BrowserWindow, Notification } from 'electron';
import { loadConfig } from './config';

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

/** Sound, OS banner and dock bounce for a task that wants attention. */
export function handleBellNotification(taskName: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (loadConfig().notifications === false) return;

  // With Bifrost in front, a task that wants attention says so in the sidebar:
  // the bar goes blue and the row carries it. Sound is for when it cannot.
  if (mainWindow.isFocused()) return;

  const bellPath = path.join(__dirname, '../../assets/bell.wav');
  if (process.platform === 'darwin') {
    execFile('afplay', [bellPath], () => {});
  } else if (process.platform === 'linux') {
    // Try paplay (PulseAudio), then pw-play (PipeWire), then aplay (ALSA)
    execFile('paplay', [bellPath], (err) => {
      if (err) {
        execFile('pw-play', [bellPath], (err2) => {
          if (err2) {
            execFile('aplay', [bellPath], () => {});
          }
        });
      }
    });
  }

  new Notification({ title: taskName, body: 'Waiting for input' }).show();
  app.dock?.bounce('informational');
}
