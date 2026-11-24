import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { IPC_STREAM } from '../shared/ipc-channels';
import { promptDraft } from '../shared/prompt-draft';
import type { ActivityEntry, Task } from '../shared/types';
import { getRecentClaudeEntries } from './claude-watcher';
import { lastReply } from './conversation-handover';
import { emit } from './event-sink';
import { relayMessage } from './oneshot';
import { peerTasks } from './peers';
import { captureScript, codexQueueScript, getRemoteHost } from './remote-host';
import {
  captureLocalSession,
  getSessionName,
  hasSession,
  waitForSessionReady,
  writeToSession,
} from './session-manager';
import { getTask, getTasks, isPendingRestore, restoreTaskSession } from './task-service';

const execFile = promisify(execFileCb);

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

// An agent's input takes a burst of characters for a paste, and an Enter
// arriving with it for part of the paste. So a prompt is typed in pieces, and
// Enter waits for the input to settle.
const PIECE_CHARS = 128;
const PIECE_GAP_MS = 15;
const ENTER_DELAY_MS = 500;
/** How long a submit has to show before Enter is pressed again, and how often. */
const SUBMIT_WAIT_MS = 3000;
const ENTER_RETRIES = 2;

// Per-task state
const activeSet = new Set<string>();
// Codex holds its queue after the user interrupts a turn, until a prompt typed at it has run.
const heldQueues = new Set<string>();
const promptQueues = new Map<string, QueuedPrompt[]>();
const turnWaiters = new Map<string, Array<() => void>>();

/** Called by bifrost-api when UserPromptSubmit hook fires for a task. */
export function markActive(taskId: string): void {
  activeSet.add(taskId);
  heldQueues.delete(taskId);
}

/** Called by bifrost-api when Codex's Interrupt hook fires for a task. */
export function markInterrupted(taskId: string): void {
  heldQueues.add(taskId);
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
}

/** Tasks with a turn in flight, which quitting is about to cut off. */
export function workingTaskIds(): string[] {
  return [...activeSet];
}

export function isIdle(taskId: string): boolean {
  return !activeSet.has(taskId);
}

/** The session's screen with its escape codes, here or on the task's machine, or null when it cannot be read. */
export async function captureTaskScreen(taskId: string): Promise<string | null> {
  const { machine } = getTask(taskId);
  return machine
    ? getRemoteHost(machine)
        .exec(captureScript(taskId))
        .catch(() => null)
    : captureLocalSession(taskId);
}

async function typeText(taskId: string, text: string): Promise<void> {
  const chars = [...text];
  for (let i = 0; i < chars.length; i += PIECE_CHARS) {
    writeToSession(taskId, chars.slice(i, i + PIECE_CHARS).join(''));
    await sleep(PIECE_GAP_MS);
  }
}

/**
 * Whether the prompt left the input: the agent's hook started a turn, or its
 * input shows nothing typed. A session already mid-turn starts no new one.
 */
async function submitted(taskId: string, wasIdle: boolean): Promise<boolean> {
  for (const end = Date.now() + SUBMIT_WAIT_MS; Date.now() < end; await sleep(200)) {
    if (wasIdle && !isIdle(taskId)) return true;
    const screen = await captureTaskScreen(taskId);
    if (screen !== null && promptDraft(screen) === '') return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function doInterruptAndSend(text: string, taskId: string): Promise<SendPromptResult> {
  // Escape stops the turn, and the input comes back a moment later.
  writeToSession(taskId, '\x1b');
  await sleep(200);
  return doSendPrompt(text, taskId);
}

async function doSendPrompt(text: string, taskId: string): Promise<SendPromptResult> {
  // Keys typed in the tab meanwhile would land inside the prompt.
  emit(IPC_STREAM.TERMINAL_LOCK, taskId);
  try {
    return await typePrompt(text, taskId);
  } finally {
    emit(IPC_STREAM.TERMINAL_UNLOCK, taskId);
  }
}

async function typePrompt(text: string, taskId: string): Promise<SendPromptResult> {
  const wasIdle = isIdle(taskId);
  const screen = await captureTaskScreen(taskId);
  const savedText = screen === null ? '' : promptDraft(screen);

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

  await typeText(taskId, text);
  let sent = false;
  for (let attempt = 0; attempt <= ENTER_RETRIES && !sent; attempt++) {
    if (attempt === 0) await sleep(ENTER_DELAY_MS);
    writeToSession(taskId, '\r');
    sent = await submitted(taskId, wasIdle);
  }

  // Typed after the submit is seen, so the draft is not sent along with the prompt.
  if (savedText) await typeText(taskId, savedText);

  return sent ? { ok: true } : { ok: false, error: 'The prompt was typed but not submitted' };
}

export function getLastAssistantMessage(taskId: string): string | null {
  const task = getTask(taskId);
  const agent = task.agent ?? 'claude';
  if (agent !== 'claude') return (task.sessionId && lastReply(agent, task.sessionId)) || null;
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
  const notReady = await readySession(taskId);
  if (notReady) return { ok: false, error: notReady };

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
      // Typed when the caller waits for the reply, so the turn it waits on is the one the prompt starts.
      if (!waitForTurn) {
        const queued = await codexQueue(taskId, text);
        if (queued) return queued;
      }
      if (isIdle(taskId)) {
        sendResult = await doSendPrompt(text, taskId);
      } else {
        // Resolves when the turn ends and the prompt is typed.
        const typed = new Promise<SendPromptResult>((resolve) => {
          let queue = promptQueues.get(taskId);
          if (!queue) {
            queue = [];
            promptQueues.set(taskId, queue);
          }
          queue.push({ text, resolve });
        });
        // A turn can outlast the caller's patience, so only a caller waiting for the reply waits for it.
        if (!waitForTurn) return { ok: true, queued: true };
        sendResult = await typed;
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

/** Queues the prompt with Codex itself, or answers null when it has to be typed. */
async function codexQueue(taskId: string, text: string): Promise<SendPromptResult | null> {
  const task = getTask(taskId);
  if (task.agent !== 'codex' || !task.sessionId || heldQueues.has(taskId)) return null;
  const script = codexQueueScript(task.sessionId, text);
  try {
    if (task.machine) await getRemoteHost(task.machine).exec(script);
    else await execFile('sh', ['-c', script], { timeout: 30_000 });
    return { ok: true, queued: !isIdle(taskId) };
  } catch (err) {
    console.warn(`[prompt] codex queue failed for ${taskId}, typing it instead: ${(err as Error).message}`);
    return null;
  }
}

/** Makes sure the task has a session that reads input, or says why it has none. */
async function readySession(taskId: string): Promise<string | null> {
  try {
    const task = getTask(taskId);
    if (task.status !== 'running') return `Task is ${task.status}, not running`;
  } catch {
    return `Task ${taskId} not found`;
  }

  // Sessions deferred on startup start on tab activation, so a send that
  // arrives first has to start one and wait for Claude's TUI: a new session
  // accepts writes seconds before Claude reads them, and early bytes are discarded.
  if (isPendingRestore(taskId)) {
    restoreTaskSession(taskId);
    if (!(await waitForSessionReady(taskId))) return 'Session did not finish starting up';
  }

  return hasSession(taskId) ? null : `Task ${taskId} has no running session`;
}

export interface MessageResult {
  ok: boolean;
  error?: string;
  /** "message" when it arrived as a SendMessage, "prompt" when it was typed or queued as a prompt. */
  via?: 'message' | 'prompt';
  queued?: boolean;
}

/** Delivers one task's message to another task's session, headed with who sent it and how to reply. */
export async function messageTask(
  taskId: string,
  fromTaskId: string | undefined,
  text: string,
): Promise<MessageResult> {
  let task: Task;
  try {
    task = getTask(taskId);
  } catch {
    return { ok: false, error: `Task ${taskId} not found` };
  }
  const wrapped = `From ${senderOf(fromTaskId)}:\n\n${text}\n\n—\n${replyHint(fromTaskId)}`;

  // SendMessage reaches only sessions on this machine, and only Claude has it.
  if (task.machine || (task.agent ?? 'claude') !== 'claude') {
    const typed = await sendPrompt(taskId, wrapped, 'queue');
    return { ok: typed.ok, error: typed.error, via: 'prompt', queued: typed.queued };
  }

  const notReady = await readySession(taskId);
  if (notReady) return { ok: false, error: notReady };
  const name = getSessionName(taskId) ?? task.name;
  return (await relayMessage(name, wrapped))
    ? { ok: true, via: 'message' }
    : { ok: false, error: `The relay could not deliver to the session "${name}"` };
}

function senderOf(fromTaskId: string | undefined): string {
  if (!fromTaskId) return 'a session outside any Bifrost task';
  const sender = [...getTasks(), ...peerTasks()].find((t) => t.id === fromTaskId);
  if (!sender) return `task ${fromTaskId}`;
  return `task "${sender.name}" (${sender.id}${sender.machine ? `, on ${sender.machine}` : ''})`;
}

function replyHint(fromTaskId: string | undefined): string {
  if (!fromTaskId) return 'The sender cannot receive a reply.';
  return (
    `Reply with the message_task tool, taskId "${fromTaskId}". Not with SendMessage: ` +
    "the sender it shows is Bifrost's courier, which has already exited."
  );
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
