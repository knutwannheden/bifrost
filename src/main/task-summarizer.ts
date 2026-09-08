import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOneShot } from './claude-oneshot';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/**
 * Derive the Claude projects directory name from a worktree path.
 * Claude Code uses the absolute path with `/` and `.` replaced by `-`.
 */
function projectDirName(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-');
}

/**
 * Get the JSONL file path for a specific session ID.
 */
function sessionJsonlPath(worktreePath: string, sessionId: string): string | null {
  const dirName = projectDirName(worktreePath);
  const filePath = path.join(CLAUDE_PROJECTS_DIR, dirName, `${sessionId}.jsonl`);
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
  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
  if (!fs.existsSync(projectDir)) return null;
  return findLargestJsonl(projectDir);
}

/**
 * Read a JSONL file, keep only user/assistant messages, and return
 * first 4 + last 6 (deduped if <= 10 total).
 */
function readHeadTail(filePath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }

  const lines = content.split('\n').filter((l) => {
    if (!l.trim()) return false;
    try {
      const type = JSON.parse(l).type;
      return type === 'user' || type === 'assistant';
    } catch {
      return false;
    }
  });

  if (lines.length <= 10) {
    return lines.join('\n');
  }

  const head = lines.slice(0, 4);
  const tail = lines.slice(-6);
  return [...head, ...tail].join('\n');
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

/** First and last exchanges of a task's Claude transcript, or null when there is none. */
export function readTranscriptExcerpt(worktreePath: string, sessionId?: string): string | null {
  const jsonlPath = resolveJsonlPath(worktreePath, sessionId);
  if (!jsonlPath) return null;
  return readHeadTail(jsonlPath) || null;
}

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

const SUMMARY_PROMPT = `You are summarizing a Claude Code session for someone scanning a list of them.

The input is a sequence of JSONL lines from the session transcript: "user" lines are the operator's
messages, "assistant" lines are Claude's replies, and the excerpt covers the first and last exchanges.

Say what the session is doing now, in one sentence a reader can tell apart from a dozen neighbours.
Name the concrete system, file, or symbol at issue. Do not claim the work is finished, do not restate
the task's title, and write no preamble, quotes, or trailing punctuation.`;

/**
 * A sentence describing where a task has got to, or null when there is no
 * transcript or the model does not answer. One at a time, and at most one
 * queued per task: a turn ending in every task at once would otherwise put a
 * process per task on the machine.
 */
export function summarizeTask(worktreePath: string, options?: { sessionId?: string }): Promise<string | null> {
  const taskId = options?.sessionId ?? worktreePath;
  return new Promise<string | null>((resolve) => {
    summarizeQueue.set(taskId, { taskId, worktreePath, sessionId: options?.sessionId, resolve });
    processQueue();
  });
}

interface SummarizeRequest {
  taskId: string;
  worktreePath: string;
  sessionId?: string;
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
    next.resolve(await runSummarize(next.worktreePath, next.sessionId));
  } catch {
    next.resolve(null);
  } finally {
    summarizeRunning = false;
    processQueue();
  }
}

async function runSummarize(worktreePath: string, sessionId?: string): Promise<string | null> {
  const input = readTranscriptExcerpt(worktreePath, sessionId);
  if (!input) return null;
  const out = await runOneShot<{ summary?: string }>({
    prompt: SUMMARY_PROMPT,
    input: `Session transcript:\n${input}`,
    model: SUMMARY_MODEL,
    schema: SUMMARY_SCHEMA,
    timeoutMs: SUMMARY_TIMEOUT_MS,
    label: 'task-summarizer',
  });
  return out?.summary?.trim() || null;
}
