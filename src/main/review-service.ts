import { spawn } from 'node:child_process';
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { IPC_STREAM } from '../shared/ipc-channels';

const BIFROST_DIR = path.join(os.homedir(), '.bifrost', 'tasks');
const REVIEW_TIMEOUT_MS = 300_000;

const REVIEW_INSTRUCTIONS = `Produce a Markdown document with:
1. A brief summary paragraph of the changes
2. A "## Review Items" section with a checked checkbox list (- [x]) of actionable findings:
   bugs, logic errors, security issues, missing edge cases, code quality concerns.
   Each item should be specific and actionable.
If the code looks good, say so and use fewer items.
Output ONLY the Markdown, no preamble.`;

const REVIEW_PROMPTS: Record<string, string> = {
  working: `Review the uncommitted changes in this worktree (git diff HEAD). ${REVIEW_INSTRUCTIONS}`,
  all: `Review all changes in this worktree since the base branch (use git to find the merge-base and diff against it). ${REVIEW_INSTRUCTIONS}`,
};

export function getReviewPath(taskId: string): string {
  return path.join(BIFROST_DIR, taskId, 'review.md');
}

export async function runReview(worktreePath: string, taskId: string, mainWindow?: BrowserWindow, scope: 'working' | 'all' = 'working', instructions?: string): Promise<string> {
  let prompt = REVIEW_PROMPTS[scope];
  if (instructions?.trim()) {
    prompt += `\n\nAdditional reviewer instructions:\n${instructions.trim()}`;
  }

  const markdown = await new Promise<string>((resolve, reject) => {
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    env.BIFROST_CONTEXT = 'review';
    env.BIFROST_TASK_ID = taskId;
    // Ensure the SessionStart hook can reach the Bifrost API
    const portFile = path.join(os.homedir(), '.bifrost', 'api-port');
    try { env.BIFROST_API_PORT = fs.readFileSync(portFile, 'utf-8').trim(); } catch { /* port file may not exist */ }

    const proc = spawn('claude', ['-p', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: worktreePath,
      env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error('Review timed out'));
      }
    }, REVIEW_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.REVIEW_PROGRESS, taskId, stdout);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      }
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Save to disk
  const reviewPath = getReviewPath(taskId);
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  lastWrittenContent.set(taskId, markdown);
  fs.writeFileSync(reviewPath, markdown, 'utf-8');

  return markdown;
}

// Track content we last wrote, so we can skip our own saves in the watcher
const lastWrittenContent = new Map<string, string>();

export function saveReview(taskId: string, content: string): void {
  const reviewPath = getReviewPath(taskId);
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  lastWrittenContent.set(taskId, content);
  fs.writeFileSync(reviewPath, content, 'utf-8');
}

export function loadReview(taskId: string): string | null {
  const reviewPath = getReviewPath(taskId);
  try {
    return fs.readFileSync(reviewPath, 'utf-8');
  } catch {
    return null;
  }
}

// File watchers: taskId -> watcher
const reviewWatchers = new Map<string, fs.FSWatcher>();

export function watchReviewFile(taskId: string, mainWindow: BrowserWindow): void {
  // Stop any existing watcher for this task
  unwatchReviewFile(taskId);

  const reviewPath = getReviewPath(taskId);
  if (!fs.existsSync(reviewPath)) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fs.watch(reviewPath, () => {
    // Debounce rapid changes (editors often write multiple times)
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const content = fs.readFileSync(reviewPath, 'utf-8');
        // Skip if this is content we just wrote ourselves
        if (content === lastWrittenContent.get(taskId)) return;
        lastWrittenContent.set(taskId, content);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.REVIEW_PROGRESS, taskId, content);
        }
      } catch {
        // File may have been deleted
      }
    }, 300);
  });

  reviewWatchers.set(taskId, watcher);
}

export function unwatchReviewFile(taskId: string): void {
  const watcher = reviewWatchers.get(taskId);
  if (watcher) {
    watcher.close();
    reviewWatchers.delete(taskId);
  }
}
