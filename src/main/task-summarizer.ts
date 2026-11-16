import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../shared/types.ts';
import { transcriptDir } from './claude-paths';
import { conversationExcerpt, transcriptFile } from './conversation-handover.ts';
import { oneShotAgent, runOneShot } from './oneshot';

/**
 * Get the JSONL file path for a specific session ID.
 */
function sessionJsonlPath(worktreePath: string, sessionId: string): string | null {
  const filePath = path.join(transcriptDir(worktreePath), `${sessionId}.jsonl`);
  return fs.existsSync(filePath) ? filePath : null;
}

/**
 * Find the largest JSONL file in the project directory (fallback when no sessionId).
 */
function findLargestJsonl(projectDir: string): string | null {
  let best: { path: string; size: number } | null = null;
  try {
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!best || stat.size > best.size) {
          best = { path: filePath, size: stat.size };
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return best?.path ?? null;
}

/**
 * Resolve the JSONL file for a task: prefer sessionId-based lookup, fall back to largest.
 */
function resolveJsonlPath(worktreePath: string, sessionId?: string): string | null {
  if (sessionId) {
    const p = sessionJsonlPath(worktreePath, sessionId);
    if (p) return p;
  }
  const projectDir = transcriptDir(worktreePath);
  if (!fs.existsSync(projectDir)) return null;
  return findLargestJsonl(projectDir);
}

/**
 * Count the number of lines in the JSONL file for a worktree.
 */
export function countJsonlLines(worktreePath: string, sessionId?: string): number {
  const jsonlPath = resolveJsonlPath(worktreePath, sessionId);
  if (!jsonlPath) return 0;

  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    return content.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/** The fields of a task that locate its conversation. */
export type ConversationSource = Pick<Task, 'agent' | 'sessionId' | 'worktreePath'>;

/** First and last turns of a task's conversation in its own agent's transcript, or null when there is none. */
export function readTranscriptExcerpt(source: ConversationSource): string | null {
  const agent = source.agent ?? 'claude';
  const file =
    agent === 'claude'
      ? resolveJsonlPath(source.worktreePath, source.sessionId)
      : source.sessionId && transcriptFile(agent, source.sessionId);
  return (file && conversationExcerpt(agent, file)) || null;
}

export const EXCERPT_FORMAT = `The input is an excerpt of the conversation between the operator and a coding agent. Each
"## User" section is one of the operator's messages, and each other section, headed with the agent's
name, is one of its replies, with tool calls and their output left out. The excerpt holds the first and
last turns, and a bracketed line says how many turns between them are left out.`;

/** Summaries run on every turn of every task, so they go to the cheapest model. */
const SUMMARY_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARY_TIMEOUT_MS = 60_000;

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One sentence, fewer than 120 characters.' },
  },
  required: ['summary'],
  additionalProperties: false,
} as const;

const SUMMARY_PROMPT = `You are summarizing a coding agent's session for someone scanning a list of them.

${EXCERPT_FORMAT}

Say what the session is doing now, in one sentence a reader can tell apart from a dozen neighbours.
Name the concrete system, file, or symbol at issue. Do not claim the work is finished, do not restate
the task's title, and write no preamble, quotes, or trailing punctuation.`;

/**
 * A sentence describing where a task has got to, or null when there is no
 * transcript or the model does not answer. One at a time, and at most one
 * queued per task: a turn ending in every task at once would otherwise put a
 * process per task on the machine.
 */
export function summarizeTask(source: ConversationSource): Promise<string | null> {
  const taskId = source.sessionId ?? source.worktreePath;
  return new Promise<string | null>((resolve) => {
    summarizeQueue.set(taskId, { taskId, source, resolve });
    processQueue();
  });
}

interface SummarizeRequest {
  taskId: string;
  source: ConversationSource;
  resolve: (result: string | null) => void;
}

const summarizeQueue = new Map<string, SummarizeRequest>();
let summarizeRunning = false;

async function processQueue(): Promise<void> {
  if (summarizeRunning) return;
  const next = summarizeQueue.values().next().value as SummarizeRequest | undefined;
  if (!next) return;
  summarizeQueue.delete(next.taskId);

  summarizeRunning = true;
  try {
    next.resolve(await runSummarize(next.source));
  } catch {
    next.resolve(null);
  } finally {
    summarizeRunning = false;
    processQueue();
  }
}

async function runSummarize(source: ConversationSource): Promise<string | null> {
  if (oneShotAgent() === 'off') return null;
  const input = readTranscriptExcerpt(source);
  if (!input) return null;
  const out = await runOneShot<{ summary?: string }>({
    prompt: SUMMARY_PROMPT,
    input: `Conversation:\n${input}`,
    claudeModel: SUMMARY_MODEL,
    effort: 'low',
    schema: SUMMARY_SCHEMA,
    timeoutMs: SUMMARY_TIMEOUT_MS,
    label: 'task-summarizer',
  });
  return out?.summary?.trim() || null;
}
