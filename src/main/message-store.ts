import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '../shared/types';
import { isIdle, sendNudge } from './prompt-sender';

export type NudgeMode = 'queue' | 'direct' | 'interrupt';

// Per-task message inbox
const inboxes = new Map<string, AgentMessage[]>();

// Pending ask reply resolvers (keyed by messageId)
const pendingReplies = new Map<
  string,
  { resolve: (text: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

// Tasks with deferred nudges (messages arrived while busy)
const deferredNudges = new Set<string>();

const ASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function getInbox(taskId: string): AgentMessage[] {
  let inbox = inboxes.get(taskId);
  if (!inbox) {
    inbox = [];
    inboxes.set(taskId, inbox);
  }
  return inbox;
}

function nudgeText(count: number): string {
  const s = count === 1 ? '' : 's';
  return `You have ${count} new agent message${s}. Use the Bifrost read_messages MCP tool to read and respond to them. Do not produce any other text output.`;
}

function triggerNudge(taskId: string, mode: NudgeMode): void {
  const unread = getUnreadCount(taskId);
  if (unread === 0) return;

  if (mode === 'queue') {
    if (isIdle(taskId)) {
      sendNudge(taskId, nudgeText(unread), 'direct');
    } else {
      deferredNudges.add(taskId);
    }
  } else {
    // 'direct' and 'interrupt' pass through to the PTY
    sendNudge(taskId, nudgeText(unread), mode);
  }
}

export function sendMessage(
  fromTaskId: string,
  fromTaskName: string,
  toTaskId: string,
  text: string,
  type: 'tell' | 'ask',
  mode: NudgeMode = 'queue',
): { messageId: string; replyPromise?: Promise<string> } {
  const message: AgentMessage = {
    id: randomUUID(),
    fromTaskId,
    fromTaskName,
    toTaskId,
    text,
    type,
    createdAt: Date.now(),
    read: false,
  };

  getInbox(toTaskId).push(message);
  triggerNudge(toTaskId, mode);

  if (type === 'ask') {
    const replyPromise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingReplies.delete(message.id);
        reject(new Error('ask_task timed out waiting for reply (5 min)'));
      }, ASK_TIMEOUT_MS);

      pendingReplies.set(message.id, { resolve, reject, timer });
    });
    return { messageId: message.id, replyPromise };
  }

  return { messageId: message.id };
}

export function readMessages(taskId: string): AgentMessage[] {
  const inbox = inboxes.get(taskId);
  if (!inbox) return [];

  const unread = inbox.filter((m) => !m.read);
  for (const m of unread) m.read = true;
  return unread;
}

export function replyToMessage(messageId: string, text: string): void {
  const pending = pendingReplies.get(messageId);
  if (!pending) {
    throw new Error(`No pending ask for message ${messageId} (already replied or timed out)`);
  }
  clearTimeout(pending.timer);
  pendingReplies.delete(messageId);
  pending.resolve(text);
}

export function getUnreadCount(taskId: string): number {
  const inbox = inboxes.get(taskId);
  if (!inbox) return 0;
  return inbox.filter((m) => !m.read).length;
}

/** Called from markIdle — send deferred nudges for messages that arrived while busy. */
export function onTaskIdle(taskId: string): void {
  if (!deferredNudges.has(taskId)) return;
  deferredNudges.delete(taskId);

  const unread = getUnreadCount(taskId);
  if (unread > 0) {
    sendNudge(taskId, nudgeText(unread), 'direct');
  }
}

/** Clean up inbox and pending replies when a task is closed. */
export function cleanupTask(taskId: string): void {
  inboxes.delete(taskId);
  deferredNudges.delete(taskId);

  // Reject any pending asks targeting this task's messages
  for (const [msgId, pending] of pendingReplies) {
    const inbox = [...inboxes.values()].flat();
    const msg = inbox.find((m) => m.id === msgId);
    if (msg && msg.toTaskId === taskId) {
      clearTimeout(pending.timer);
      pendingReplies.delete(msgId);
      pending.reject(new Error('Recipient task was closed'));
    }
  }
}
