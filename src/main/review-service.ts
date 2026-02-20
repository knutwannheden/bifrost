import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { IPC_STREAM } from '../shared/ipc-channels';
import type { ReviewEntry } from '../shared/types';

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

// --- Public API ---

export function listReviews(taskId: string): ReviewEntry[] {
  return migrateIfNeeded(taskId);
}

export async function runReview(
  worktreePath: string,
  taskId: string,
  mainWindow?: BrowserWindow,
  scope: 'working' | 'all' = 'working',
  instructions?: string,
): Promise<{ reviewId: string; markdown: string }> {
  const reviewId = randomUUID();

  let prompt = REVIEW_PROMPTS[scope];
  if (instructions?.trim()) {
    prompt += `\n\nAdditional reviewer instructions:\n${instructions.trim()}`;
  }

  const markdown = await new Promise<string>((resolve, reject) => {
    const env = { ...process.env } as Record<string, string>;
    delete env.CLAUDECODE;
    env.BIFROST_CONTEXT = 'review';
    env.BIFROST_TASK_ID = taskId;
    env.BIFROST_REVIEW_ID = reviewId;
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
        mainWindow.webContents.send(IPC_STREAM.REVIEW_PROGRESS, taskId, reviewId, stdout);
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

  // Create review entry in manifest
  const entry: ReviewEntry = {
    id: reviewId,
    scope,
    instructions: instructions?.trim() || undefined,
    timestamp: Date.now(),
  };

  const entries = migrateIfNeeded(taskId);
  entries.push(entry);
  writeManifest(taskId, entries);

  // Save review content
  lastWrittenContent.set(reviewId, markdown);
  fs.writeFileSync(getReviewFilePath(taskId, reviewId), markdown, 'utf-8');

  return { reviewId, markdown };
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
