import type { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';
import { getTask } from './ipc-handlers';
import { writeToSession } from './session-manager';

export type SendPromptMode = 'direct' | 'queue' | 'only-when-idle';

interface QueuedPrompt {
  text: string;
  resolve: (result: SendPromptResult) => void;
}

export interface SendPromptResult {
  ok: boolean;
  error?: string;
  queued?: boolean;
}

// Per-task state
const activeSet = new Set<string>();
const promptQueues = new Map<string, QueuedPrompt[]>();

let mainWindow: BrowserWindow | null = null;
const scrapeResponseResolvers = new Map<string, (text: string) => void>();
let scrapeIdCounter = 0;

export function initPromptSender(window: BrowserWindow): void {
  mainWindow = window;
}

/** Called by bifrost-api when UserPromptSubmit hook fires for a task. */
export function markActive(taskId: string): void {
  activeSet.add(taskId);
}

/** Called by bifrost-api when Stop hook fires for a task. */
export function markIdle(taskId: string): void {
  activeSet.delete(taskId);

  // Drain queue — send next queued prompt
  const queue = promptQueues.get(taskId);
  if (queue && queue.length > 0) {
    const next = queue.shift()!;
    if (queue.length === 0) promptQueues.delete(taskId);
    doSendPrompt(next.text, taskId).then(next.resolve);
  }
}

/** Handle scrape response from renderer. */
export function handleScrapeResponse(requestId: string, text: string): void {
  const resolver = scrapeResponseResolvers.get(requestId);
  if (resolver) {
    scrapeResponseResolvers.delete(requestId);
    resolver(text);
  }
}

function isIdle(taskId: string): boolean {
  return !activeSet.has(taskId);
}

async function scrapePartialPrompt(taskId: string): Promise<string> {
  if (!mainWindow || mainWindow.isDestroyed()) return '';

  const requestId = `scrape-${++scrapeIdCounter}`;
  return new Promise<string>((resolve) => {
    // Timeout after 2s — if renderer doesn't respond, assume empty and unlock
    const timer = setTimeout(() => {
      scrapeResponseResolvers.delete(requestId);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.TERMINAL_UNLOCK, taskId);
      }
      resolve('');
    }, 2000);

    scrapeResponseResolvers.set(requestId, (text) => {
      clearTimeout(timer);
      resolve(text);
    });

    mainWindow!.webContents.send(IPC_STREAM.SCRAPE_PROMPT_REQUEST, taskId, requestId);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function doSendPrompt(text: string, taskId: string): Promise<SendPromptResult> {
  // Scrape any partial prompt the user typed (also locks terminal input)
  const savedText = await scrapePartialPrompt(taskId);

  // Clear any existing input regardless of cursor position.
  // Option+Backspace (\x1b\x7f) erases one word backward per press.
  // Ctrl+K (\x0b) kills forward to end of line per press.
  // Use word count for backward (+ padding) and line count for forward.
  if (savedText) {
    const lines = savedText.split('\n');
    const wordCount = savedText.split(/\s+/).filter(Boolean).length;
    // Backward: one per word + one per line boundary for safety
    for (let i = 0; i < wordCount + lines.length; i++) {
      writeToSession(taskId, '\x1b\x7f');
      await sleep(10);
    }
    // Forward: kill remaining content after cursor
    for (let i = 0; i < lines.length; i++) {
      writeToSession(taskId, '\x0b');
      await sleep(10);
    }
  }

  // Send the prompt
  writeToSession(taskId, `${text}\r`);

  // Restore saved text immediately — characters written to the PTY
  // will be buffered in stdin and appear when the prompt area returns.
  if (savedText) {
    writeToSession(taskId, savedText.replace(/\n/g, '\r'));
  }

  // Unlock terminal input in the renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.TERMINAL_UNLOCK, taskId);
  }

  return { ok: true };
}

export async function sendPrompt(
  taskId: string,
  text: string,
  mode: SendPromptMode = 'direct',
): Promise<SendPromptResult> {
  // Validate task exists and is running
  try {
    const task = getTask(taskId);
    if (task.status !== 'running') {
      return { ok: false, error: `Task is ${task.status}, not running` };
    }
  } catch {
    return { ok: false, error: `Task ${taskId} not found` };
  }

  switch (mode) {
    case 'direct':
      return doSendPrompt(text, taskId);

    case 'only-when-idle':
      if (!isIdle(taskId)) {
        return { ok: false, error: 'Claude is currently active' };
      }
      return doSendPrompt(text, taskId);

    case 'queue':
      if (isIdle(taskId)) {
        return doSendPrompt(text, taskId);
      }
      // Queue for later
      return new Promise<SendPromptResult>((resolve) => {
        let queue = promptQueues.get(taskId);
        if (!queue) {
          queue = [];
          promptQueues.set(taskId, queue);
        }
        queue.push({ text, resolve });
      });

    default:
      return { ok: false, error: `Unknown mode: ${mode}` };
  }
}

/** Resolve a taskId from either explicit taskId or callerTaskId. */
export function resolveTaskId(taskId?: string, callerTaskId?: string): string | null {
  if (taskId) return taskId;
  if (callerTaskId) {
    try {
      getTask(callerTaskId);
      return callerTaskId;
    } catch {
      return null;
    }
  }
  return null;
}
