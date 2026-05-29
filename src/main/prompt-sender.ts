import type { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';
import type { ActivityEntry } from '../shared/types';
import { getRecentClaudeEntries } from './claude-watcher';
import { getTask, isPendingRestore, restoreTaskSession } from './ipc-handlers';
import { onTaskIdle as deliverDeferredMessages } from './message-store';
import { writeToSession } from './session-manager';

export type SendPromptMode = 'direct' | 'queue' | 'only-when-idle' | 'interrupt';

interface QueuedPrompt {
  text: string;
  resolve: (result: SendPromptResult) => void;
}

export interface SendPromptResult {
  ok: boolean;
  error?: string;
  queued?: boolean;
  response?: string;
}

// Per-task state
const activeSet = new Set<string>();
const promptQueues = new Map<string, QueuedPrompt[]>();
const turnWaiters = new Map<string, Array<() => void>>();

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

  // Resolve any waiters blocked on turn completion
  const waiters = turnWaiters.get(taskId);
  if (waiters && waiters.length > 0) {
    turnWaiters.delete(taskId);
    for (const resolve of waiters) resolve();
  }

  // Drain queue — send next queued prompt
  const queue = promptQueues.get(taskId);
  if (queue && queue.length > 0) {
    const next = queue.shift()!;
    if (queue.length === 0) promptQueues.delete(taskId);
    doSendPrompt(next.text, taskId).then(next.resolve);
  }

  // Deliver deferred agent message nudges
  deliverDeferredMessages(taskId);
}

/** Handle scrape response from renderer. */
export function handleScrapeResponse(requestId: string, text: string): void {
  const resolver = scrapeResponseResolvers.get(requestId);
  if (resolver) {
    scrapeResponseResolvers.delete(requestId);
    resolver(text);
  }
}

export function isIdle(taskId: string): boolean {
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

async function doInterruptAndSend(text: string, taskId: string): Promise<SendPromptResult> {
  // Send Escape to stop current generation, then wait for prompt area
  writeToSession(taskId, '\x1b');
  await sleep(200);
  // Send text and submit separately so Claude's TUI doesn't treat the
  // chunk as a paste (which would insert \r as a literal newline).
  writeToSession(taskId, text);
  await sleep(10);
  writeToSession(taskId, '\r');
  return { ok: true };
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

  // Send text and submit separately so Claude's TUI doesn't treat the
  // chunk as a paste (which would insert \r as a literal newline).
  writeToSession(taskId, text);
  await sleep(10);
  writeToSession(taskId, '\r');

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

function getLastAssistantMessage(taskId: string): string | null {
  const task = getTask(taskId);
  const entries = getRecentClaudeEntries(taskId, task.worktreePath);
  const isAgentOutput = (e: ActivityEntry) =>
    e.claudeEventKind === 'assistant_text' ||
    (e.claudeEventKind === 'tool_use' && e.claudeToolName === 'AskUserQuestion');
  const last = [...entries].reverse().find(isAgentOutput);
  return last?.claudeText ?? null;
}

function waitForTurnComplete(taskId: string): Promise<void> {
  return new Promise((resolve) => {
    let waiters = turnWaiters.get(taskId);
    if (!waiters) {
      waiters = [];
      turnWaiters.set(taskId, waiters);
    }
    waiters.push(resolve);
  });
}

export async function sendPrompt(
  taskId: string,
  text: string,
  mode: SendPromptMode = 'direct',
  waitForTurn = false,
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

  // Auto-restore tasks whose sessions were deferred on startup.
  // Force queue mode since the session needs time to start up.
  if (isPendingRestore(taskId) && mainWindow && !mainWindow.isDestroyed()) {
    restoreTaskSession(taskId, mainWindow);
    mode = 'queue';
  }

  let sendResult: SendPromptResult;

  switch (mode) {
    case 'direct':
      sendResult = await doSendPrompt(text, taskId);
      break;

    case 'interrupt':
      sendResult = await doInterruptAndSend(text, taskId);
      break;

    case 'only-when-idle':
      if (!isIdle(taskId)) {
        return { ok: false, error: 'Claude is currently active' };
      }
      sendResult = await doSendPrompt(text, taskId);
      break;

    case 'queue':
      if (isIdle(taskId)) {
        sendResult = await doSendPrompt(text, taskId);
      } else {
        // Queue for later — resolves when the queued prompt is actually sent
        sendResult = await new Promise<SendPromptResult>((resolve) => {
          let queue = promptQueues.get(taskId);
          if (!queue) {
            queue = [];
            promptQueues.set(taskId, queue);
          }
          queue.push({ text, resolve });
        });
      }
      break;

    default:
      return { ok: false, error: `Unknown mode: ${mode}` };
  }

  if (!sendResult.ok || !waitForTurn) return sendResult;

  // Block until the turn completes, then include the response
  await waitForTurnComplete(taskId);
  sendResult.response = getLastAssistantMessage(taskId) ?? undefined;
  return sendResult;
}

/**
 * Send a system nudge to a task's PTY. Used by message-store to notify
 * recipients about new agent messages. Unlike sendPrompt, this skips
 * scrape/restore of user input — it's a lightweight PTY write.
 */
export function sendNudge(taskId: string, text: string, mode: 'direct' | 'interrupt'): void {
  // Send text and submit separately so Claude's TUI doesn't treat the
  // chunk as a paste (which would insert \r as a literal newline).
  const submit = () => {
    writeToSession(taskId, text);
    setTimeout(() => writeToSession(taskId, '\r'), 10);
  };
  if (mode === 'interrupt') {
    writeToSession(taskId, '\x1b');
    setTimeout(submit, 200);
  } else {
    submit();
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
