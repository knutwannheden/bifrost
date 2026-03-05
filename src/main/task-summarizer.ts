import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const SUMMARY_TIMEOUT_MS = 30_000;

const SUMMARY_PROMPT = `You are summarizing a Claude Code session transcript. The input is a sequence of JSONL lines from the session.

Each line is a JSON object with a "type" field:
- "user": A message from the user. The "message.content" field contains the user's text or tool results.
- "assistant": A response from Claude. The "message.content" array may contain "text" (prose), "thinking" (internal reasoning), or "tool_use" (tool invocations) blocks.

The input contains the first few and last few user/assistant exchanges to give you both the initial intent and the current state of the work.

Output exactly two short plain-text sentences on a single line, no markdown, no bullet points, no numbering. The first sentence should capture the goal or intent. The second should describe the current focus or state of the work. Start with an action verb (e.g. "Implementing...", "Fixing...", "Investigating..."). Do not start with "A Claude Code session", "The user", or similar filler.`;

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
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
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
 * Try to summarize using an ollama model. Returns summary or null.
 */
function tryOllama(model: string, input: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const proc = spawn('ollama', ['run', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve(null);
      }
    }, SUMMARY_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(null);
    });

    proc.stdin.write(SUMMARY_PROMPT + '\n\n' + input);
    proc.stdin.end();
  });
}

/**
 * Summarize using claude -p --model haiku as fallback.
 */
function tryClaude(input: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const jsonSchema = JSON.stringify({
      type: 'object',
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
    });

    const proc = spawn('claude', [
      '-p',
      '--model', 'haiku',
      '--output-format', 'json',
      '--json-schema', jsonSchema,
      SUMMARY_PROMPT,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        resolve(null);
      }
    }, SUMMARY_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) {
        try {
          const wrapper = JSON.parse(stdout);
          const inner = JSON.parse(wrapper.result);
          resolve(inner.summary ?? null);
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    });

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(null);
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

export interface SummarizeOptions {
  sessionId?: string;
  ollamaModels?: string[];
}

/**
 * Summarize a task by feeding JSONL transcript head+tail to ollama (preferred)
 * or claude haiku (fallback). Returns the summary, or null on failure.
 */
export async function summarizeTask(worktreePath: string, options?: SummarizeOptions): Promise<string | null> {
  const jsonlPath = resolveJsonlPath(worktreePath, options?.sessionId);
  if (!jsonlPath) return null;

  const input = readHeadTail(jsonlPath);
  if (!input) return null;

  const models = options?.ollamaModels ?? [];
  for (const model of models) {
    const result = await tryOllama(model, input);
    if (result) return result;
  }

  return tryClaude(input);
}
