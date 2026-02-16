import { app, BrowserWindow, Notification } from 'electron';
import { execFile } from 'node:child_process';
import { IPC_STREAM } from '../shared/ipc-channels';
import { getRecentClaudeEntries } from './claude-watcher';

let mainWindow: BrowserWindow | null = null;

/** Strip Markdown formatting to plain text for OS notifications. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '')       // fenced code blocks
    .replace(/`([^`]+)`/g, '$1')          // inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')    // bold
    .replace(/\*([^*]+)\*/g, '$1')        // italic
    .replace(/__([^_]+)__/g, '$1')        // bold (underscore)
    .replace(/_([^_]+)_/g, '$1')          // italic (underscore)
    .replace(/~~([^~]+)~~/g, '$1')        // strikethrough
    .replace(/^#{1,6}\s+/gm, '')          // headings
    .replace(/^\s*[-*+]\s+/gm, '- ')     // unordered list markers
    .replace(/^\s*\d+\.\s+/gm, '')       // ordered list markers
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // images
    .replace(/\n{2,}/g, '\n')            // collapse blank lines
    .trim();
}

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

  // Sound always plays so the user notices even when focused
  execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], () => {});

  // OS notification + dock bounce only when window is not focused
  if (!mainWindow.isFocused()) {
    new Notification({ title, body: stripMarkdown(body) }).show();
    app.dock?.bounce('informational');
  }
}
