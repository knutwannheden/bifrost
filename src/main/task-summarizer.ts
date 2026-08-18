import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const SUMMARY_TIMEOUT_MS = 30_000;

/** Cached set of installed ollama model names (refreshed periodically). */
let ollamaModelsCache: Set<string> | null = null;
let ollamaModelsCacheTime = 0;
const OLLAMA_CACHE_TTL_MS = 60_000;

export function getInstalledOllamaModels(): Set<string> {
  const now = Date.now();
  if (ollamaModelsCache && now - ollamaModelsCacheTime < OLLAMA_CACHE_TTL_MS) {
    return ollamaModelsCache;
  }
  try {
    const output = execSync('ollama list', { timeout: 5000, encoding: 'utf-8' });
    const models = new Set<string>();
    for (const line of output.split('\n').slice(1)) {
      const name = line.split(/\s+/)[0];
      if (name) models.add(name);
    }
    ollamaModelsCache = models;
    ollamaModelsCacheTime = now;
    return models;
  } catch {
    ollamaModelsCache = new Set();
    ollamaModelsCacheTime = now;
    return ollamaModelsCache;
  }
}

const SUMMARY_PROMPT = `You are summarizing a Claude Code session transcript. The input is a sequence of JSONL lines from the session.

Each line is a JSON object with a "type" field:
- "user": A message from the user. The "message.content" field contains the user's text or tool results.
- "assistant": A response from Claude. The "message.content" array may contain "text" (prose), "thinking" (internal reasoning), or "tool_use" (tool invocations) blocks.

The input contains the first few and last few user/assistant exchanges to give you both the initial intent and the current state of the work.

Output exactly two short plain-text sentences on a single line, no markdown, no bullet points, no numbering. The first sentence should capture the goal or intent. The second should describe the current focus or state of the work. Start with an action verb (e.g. "Implementing...", "Fixing...", "Investigating...").

CRITICAL: Write the summary DIRECTLY. Do NOT repeat or reference these instructions. Do NOT start with "Summarize...", "Provide...", "The assistant is...", "A Claude Code session...", "The user...". Just state what the session is about.

GOOD: "Fixing RPC serialization for C# nullable types. Currently investigating a deserialization failure in the .nettrace parser."
BAD: "Summarize a session about RPC changes. The assistant is reviewing code."
BAD: "Provide an in-depth summary of RPC and C# changes."`;

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

/**
 * Try to summarize using ollama's HTTP API. Returns summary or null.
 */
function tryOllama(model: string, input: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const body = JSON.stringify({
      model,
      prompt: `${SUMMARY_PROMPT}\n\n${input}`,
      stream: false,
    });

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 11434,
        path: '/api/generate',
        method: 'POST',
        timeout: SUMMARY_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString());
            const text = (json.response as string)?.trim();
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

export interface SummarizeOptions {
  sessionId?: string;
  ollamaModels?: string[];
}

interface SummarizeRequest {
  taskId: string;
  worktreePath: string;
  options?: SummarizeOptions;
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
    next.resolve(await runSummarize(next.worktreePath, next.options));
  } catch {
    next.resolve(null);
  } finally {
    summarizeRunning = false;
    processQueue();
  }
}

/** First and last exchanges of a task's Claude transcript, or null when there is none. */
export function readTranscriptExcerpt(worktreePath: string, sessionId?: string): string | null {
  const jsonlPath = resolveJsonlPath(worktreePath, sessionId);
  if (!jsonlPath) return null;
  return readHeadTail(jsonlPath) || null;
}

async function runSummarize(worktreePath: string, options?: SummarizeOptions): Promise<string | null> {
  const input = readTranscriptExcerpt(worktreePath, options?.sessionId);
  if (!input) return null;

  const installed = getInstalledOllamaModels();
  const model = (options?.ollamaModels ?? []).find(
    (m) => installed.has(m) || installed.has(m.includes(':') ? m : `${m}:latest`),
  );
  if (!model) return null;
  return tryOllama(model, input);
}

/**
 * Summarize a task by feeding the JSONL transcript head+tail to ollama.
 * Returns the summary, or null on failure or when no ollama model is available.
 * Requests are queued with at most one entry per task. Only one summarization
 * runs at a time to avoid spawning many ollama processes.
 */
export function summarizeTask(worktreePath: string, options?: SummarizeOptions): Promise<string | null> {
  const taskId = options?.sessionId ?? worktreePath;
  return new Promise<string | null>((resolve) => {
    summarizeQueue.set(taskId, { taskId, worktreePath, options, resolve });
    processQueue();
  });
}
