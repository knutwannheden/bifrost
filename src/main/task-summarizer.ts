import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const SUMMARY_TIMEOUT_MS = 30_000;

/**
 * Derive the Claude projects directory name from a worktree path.
 * Claude Code uses the absolute path with `/` and `.` replaced by `-`.
 */
function projectDirName(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-');
}

/**
 * Find the largest JSONL file in the project directory.
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
 * Read a JSONL file and return first 5 + last 5 lines (deduped if < 10 total).
 */
function readHeadTail(filePath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }

  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length <= 10) {
    return lines.join('\n');
  }

  const head = lines.slice(0, 5);
  const tail = lines.slice(-5);
  return [...head, ...tail].join('\n');
}

/**
 * Count the number of lines in the largest JSONL file for a worktree.
 */
export function countJsonlLines(worktreePath: string): number {
  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
  if (!fs.existsSync(projectDir)) return 0;

  const jsonlPath = findLargestJsonl(projectDir);
  if (!jsonlPath) return 0;

  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    return content.split('\n').filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Summarize a task by feeding JSONL transcript head+tail to `claude -p --model haiku`.
 * Returns the one-sentence summary, or null on failure.
 */
export async function summarizeTask(worktreePath: string): Promise<string | null> {
  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);

  if (!fs.existsSync(projectDir)) return null;

  const jsonlPath = findLargestJsonl(projectDir);
  if (!jsonlPath) return null;

  const input = readHeadTail(jsonlPath);
  if (!input) return null;

  return new Promise<string | null>((resolve) => {
    const proc = spawn('claude', [
      '-p',
      '--model', 'haiku',
      'Summarize what was accomplished in this Claude Code session in one short sentence. Start directly with the action verb (e.g. "Drafted...", "Implemented...", "Fixed..."). Do NOT start with "A Claude Code session", "The user", or similar filler. Output ONLY the summary, nothing else.',
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

    proc.stdin.write(input);
    proc.stdin.end();
  });
}
