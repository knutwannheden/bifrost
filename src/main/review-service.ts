import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { IPC_STREAM } from '../shared/ipc-channels';
import type { ReviewEntry } from '../shared/types';
import { spawnSession, killSession } from './session-manager';

const BIFROST_DIR = path.join(os.homedir(), '.bifrost', 'tasks');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const REVIEW_TIMEOUT_MS = 900_000;

const REVIEW_INSTRUCTIONS = `Produce a Markdown document with:
1. A brief summary paragraph of the changes
2. A "## Review Items" section with a checked checkbox list (- [x]) of actionable findings:
   bugs, logic errors, security issues, missing edge cases, code quality concerns.
   Each item should be specific and actionable, prefixed with a severity tag:
   \`[critical]\` — bugs, security vulnerabilities, data loss risks
   \`[important]\` — logic errors, missing edge cases, correctness issues
   \`[suggestion]\` — code quality, style, maintainability improvements
   Order items by severity (critical first).
If the code looks good, say so and use fewer items.
Write ONLY the Markdown to the specified file, no preamble.`;

function getReviewPrompt(scope: 'working' | 'all', baseBranch?: string): string {
  if (scope === 'all' && baseBranch) {
    return `Review all changes in this worktree since the base branch. Use \`git merge-base ${baseBranch} HEAD\` to find the fork point and diff against it. ${REVIEW_INSTRUCTIONS}`;
  }
  return `Review the uncommitted changes in this worktree (git diff HEAD). ${REVIEW_INSTRUCTIONS}`;
}

// --- Path helpers ---

function getReviewDir(taskId: string): string {
  return path.join(BIFROST_DIR, taskId, 'reviews');
}

function getManifestPath(taskId: string): string {
  return path.join(getReviewDir(taskId), 'index.json');
}

function getReviewFilePath(taskId: string, reviewId: string): string {
  return path.join(getReviewDir(taskId), `${reviewId}.md`);
}

/** Legacy single-file path (for migration) */
function getLegacyReviewPath(taskId: string): string {
  return path.join(BIFROST_DIR, taskId, 'review.md');
}

// --- Manifest helpers ---

function readManifest(taskId: string): ReviewEntry[] {
  try {
    return JSON.parse(fs.readFileSync(getManifestPath(taskId), 'utf-8'));
  } catch {
    return [];
  }
}

function writeManifest(taskId: string, entries: ReviewEntry[]): void {
  const dir = getReviewDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getManifestPath(taskId), JSON.stringify(entries, null, 2), 'utf-8');
}

// --- Migration ---

/**
 * If an old review.md exists but no reviews/ directory, migrate to the new format.
 * Returns the migrated entries (or existing entries if already migrated).
 */
export function migrateIfNeeded(taskId: string, legacySessionId?: string): ReviewEntry[] {
  const manifestPath = getManifestPath(taskId);
  const legacyPath = getLegacyReviewPath(taskId);

  // Already migrated or no legacy file
  if (fs.existsSync(manifestPath)) {
    return readManifest(taskId);
  }

  if (!fs.existsSync(legacyPath)) {
    return [];
  }

  // Migrate
  const reviewId = randomUUID();
  const content = fs.readFileSync(legacyPath, 'utf-8');
  const entry: ReviewEntry = {
    id: reviewId,
    scope: 'working',
    timestamp: Date.now(),
    sessionId: legacySessionId,
  };

  const dir = getReviewDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getReviewFilePath(taskId, reviewId), content, 'utf-8');
  writeManifest(taskId, [entry]);

  // Remove legacy file
  try { fs.unlinkSync(legacyPath); } catch { /* ignore */ }

  return [entry];
}

// --- Running review tracking ---

const runningReviews = new Map<string, string>(); // taskId -> ptySessionId
const cancelledReviews = new Set<string>();

// --- Public API ---

export function listReviews(taskId: string): ReviewEntry[] {
  return migrateIfNeeded(taskId);
}

export async function runReview(
  worktreePath: string,
  taskId: string,
  mainWindow: BrowserWindow,
  scope: 'working' | 'all' = 'working',
  instructions?: string,
  baseBranch?: string,
): Promise<{ reviewId: string; markdown: string }> {
  const reviewId = randomUUID();
  const reviewFilePath = getReviewFilePath(taskId, reviewId);

  // Create manifest entry before spawning so session-start hook can set sessionId
  const entry: ReviewEntry = {
    id: reviewId,
    scope,
    instructions: instructions?.trim() || undefined,
    timestamp: Date.now(),
  };
  const entries = migrateIfNeeded(taskId);
  entries.push(entry);
  writeManifest(taskId, entries);

  let prompt = getReviewPrompt(scope, baseBranch);
  if (instructions?.trim()) {
    prompt += `\n\nAdditional reviewer instructions:\n${instructions.trim()}`;
  }
  prompt += `\n\nWrite the review document to: ${reviewFilePath}\nIf later resumed for discussion and asked to update the review, write changes to that same file.`;

  const ptySessionId = `${taskId}-review`;
  killSession(ptySessionId);

  const extraEnv: Record<string, string> = {
    BIFROST_CONTEXT: 'review',
    BIFROST_TASK_ID: taskId,
    BIFROST_REVIEW_ID: reviewId,
  };
  const portFile = path.join(os.homedir(), '.bifrost', 'api-port');
  try { extraEnv.BIFROST_API_PORT = fs.readFileSync(portFile, 'utf-8').trim(); } catch { /* port file may not exist */ }

  // Ensure review dir exists for file watcher
  fs.mkdirSync(path.dirname(reviewFilePath), { recursive: true });
  watchReviewFile(taskId, reviewId, mainWindow);

  const markdown = await new Promise<string>((resolve, reject) => {
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        runningReviews.delete(taskId);
        stopReviewActivityWatch(taskId);
        killSession(ptySessionId);
        reject(new Error('Review timed out'));
      }
    }, REVIEW_TIMEOUT_MS);

    cancelledReviews.delete(taskId);
    runningReviews.set(taskId, ptySessionId);

    spawnSession(ptySessionId, 'claude', ['--dangerously-skip-permissions'], worktreePath, mainWindow, {
      extraEnv,
      autoTrust: true,
      prompt,
      onBeforeExit: (_buffer, exitCode) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timeout);
        runningReviews.delete(taskId);
        stopReviewActivityWatch(taskId);

        if (cancelledReviews.has(taskId)) {
          cancelledReviews.delete(taskId);
          reject(new Error('Review cancelled'));
        } else if (exitCode === 0) {
          try {
            const content = fs.readFileSync(reviewFilePath, 'utf-8').trim();
            if (content) {
              resolve(content);
            } else {
              reject(new Error('Review produced no output'));
            }
          } catch {
            reject(new Error('Review file not written'));
          }
        } else {
          reject(new Error(`claude exited with code ${exitCode}`));
        }
        return false;
      },
    });
  });

  // Track content so file watcher skips our own read
  lastWrittenContent.set(reviewId, markdown);

  return { reviewId, markdown };
}

export function cancelReview(taskId: string): void {
  stopReviewActivityWatch(taskId);
  const ptySessionId = runningReviews.get(taskId);
  if (!ptySessionId) return;
  cancelledReviews.add(taskId);
  killSession(ptySessionId);
}

// Track content we last wrote, so we can skip our own saves in the watcher
const lastWrittenContent = new Map<string, string>();


export function saveReview(taskId: string, reviewId: string, content: string): void {
  const reviewPath = getReviewFilePath(taskId, reviewId);
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  lastWrittenContent.set(reviewId, content);
  fs.writeFileSync(reviewPath, content, 'utf-8');
}

export function loadReview(taskId: string, reviewId: string): string | null {
  const reviewPath = getReviewFilePath(taskId, reviewId);
  try {
    return fs.readFileSync(reviewPath, 'utf-8');
  } catch {
    return null;
  }
}

export function deleteReview(taskId: string, reviewId: string): void {
  const entries = readManifest(taskId);
  const updated = entries.filter((e) => e.id !== reviewId);
  writeManifest(taskId, updated);

  const reviewPath = getReviewFilePath(taskId, reviewId);
  try { fs.unlinkSync(reviewPath); } catch { /* ignore */ }

  unwatchReviewFile(reviewId);
}

export function getReviewSessionId(taskId: string, reviewId: string): string | undefined {
  const entries = readManifest(taskId);
  return entries.find((e) => e.id === reviewId)?.sessionId;
}

export function setReviewSessionId(taskId: string, reviewId: string, sessionId: string): void {
  const entries = readManifest(taskId);
  const entry = entries.find((e) => e.id === reviewId);
  if (entry) {
    entry.sessionId = sessionId;
    writeManifest(taskId, entries);
  }
}

// File watchers: reviewId -> watcher
const reviewWatchers = new Map<string, fs.FSWatcher>();

export function watchReviewFile(taskId: string, reviewId: string, mainWindow: BrowserWindow): void {
  // Stop any existing watcher for this review
  unwatchReviewFile(reviewId);

  const reviewPath = getReviewFilePath(taskId, reviewId);
  if (!fs.existsSync(reviewPath)) return;

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = fs.watch(reviewPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const content = fs.readFileSync(reviewPath, 'utf-8');
        if (content === lastWrittenContent.get(reviewId)) return;
        lastWrittenContent.set(reviewId, content);
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.REVIEW_PROGRESS, taskId, reviewId, content);
        }
      } catch {
        // File may have been deleted
      }
    }, 300);
  });

  reviewWatchers.set(reviewId, watcher);
}

export function unwatchReviewFile(reviewId: string): void {
  const watcher = reviewWatchers.get(reviewId);
  if (watcher) {
    watcher.close();
    reviewWatchers.delete(reviewId);
  }
}

// --- Review activity polling (shows last JSONL message during review) ---

const reviewActivityIntervals = new Map<string, ReturnType<typeof setInterval>>();

function projectDirName(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-');
}

function findSessionJsonl(worktreePath: string, sessionId: string): string | null {
  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectDirName(worktreePath), `${sessionId}.jsonl`);
  return fs.existsSync(filePath) ? filePath : null;
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read': return `Reading ${input.file_path || ''}`;
    case 'Edit': return `Editing ${input.file_path || ''}`;
    case 'Write': return `Writing ${input.file_path || ''}`;
    case 'Bash': return `$ ${(input.command as string || '').slice(0, 80)}`;
    case 'Glob': return `Searching ${input.pattern || ''}`;
    case 'Grep': return `Searching for /${input.pattern || ''}/`;
    case 'Task': return `Agent: ${input.description || ''}`;
    default: return name;
  }
}

function readLastActivity(filePath: string): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (stat.size === 0) return null;

  const readSize = Math.min(stat.size, 32768);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);

  const lines = buf.toString('utf-8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type !== 'assistant') continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      // Prefer last tool_use, then last text
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j].type === 'tool_use') {
          return formatToolUse(content[j].name, content[j].input as Record<string, unknown>);
        }
        if (content[j].type === 'text') {
          const text = (content[j].text as string || '').trim();
          if (text) return text.length > 100 ? text.slice(0, 100) + '...' : text;
        }
      }
    } catch { /* skip malformed lines */ }
  }
  return null;
}

export function startReviewActivityWatch(
  taskId: string,
  reviewId: string,
  worktreePath: string,
  sessionId: string,
  mainWindow: BrowserWindow,
): void {
  stopReviewActivityWatch(taskId);

  let jsonlPath: string | null = null;
  let lastActivity = '';

  const interval = setInterval(() => {
    if (!jsonlPath) {
      jsonlPath = findSessionJsonl(worktreePath, sessionId);
      if (!jsonlPath) return;
    }
    const activity = readLastActivity(jsonlPath);
    if (activity && activity !== lastActivity) {
      lastActivity = activity;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.REVIEW_ACTIVITY, taskId, reviewId, activity);
      }
    }
  }, 1500);

  reviewActivityIntervals.set(taskId, interval);
}

export function stopReviewActivityWatch(taskId: string): void {
  const interval = reviewActivityIntervals.get(taskId);
  if (interval) {
    clearInterval(interval);
    reviewActivityIntervals.delete(taskId);
  }
}
