import { BrowserWindow, Notification } from 'electron';
import { execFile } from 'node:child_process';
import { IPC_STREAM } from '../shared/ipc-channels';
import { getRecentClaudeEntries } from './claude-watcher';

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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function handleAgentNotification(taskId: string, taskName: string, worktreePath: string, _type: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Get the last assistant message from Claude JSONL entries
  const entries = getRecentClaudeEntries(taskId, worktreePath);
  const lastAssistant = [...entries]
    .reverse()
    .find((e) => e.claudeEventKind === 'assistant_text');
  const body = lastAssistant?.claudeText || 'Waiting for input';
  const title = taskName;

  // Send to renderer — it decides whether to show a toast based on active task
  mainWindow.webContents.send(IPC_STREAM.AGENT_NOTIFICATION, taskId, title, body);

  // OS notification + sound only when window is not focused
  if (!mainWindow.isFocused()) {
    new Notification({ title, body }).show();
    execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});
  }
}
