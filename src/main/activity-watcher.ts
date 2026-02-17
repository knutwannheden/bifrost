import { BrowserWindow } from 'electron';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ActivityEntry } from '../shared/types';
import { IPC_STREAM } from '../shared/ipc-channels';
import { startClaudeWatching, stopClaudeWatching, getRecentClaudeEntries, type ClaudeWatcherCallbacks } from './claude-watcher';

const execFile = promisify(execFileCb);

const ACTIVITY_DIR = path.join(os.homedir(), '.bifrost', 'activity');
const POLL_INTERVAL_MS = 2000;

interface TaskWatcher {
  pollTimer: ReturnType<typeof setInterval>;
  entries: ActivityEntry[];
  headSha: string | null;
  knownFiles: Set<string>;
}

const watchers = new Map<string, TaskWatcher>();

function ensureActivityDir(): void {
  if (!fs.existsSync(ACTIVITY_DIR)) {
    fs.mkdirSync(ACTIVITY_DIR, { recursive: true });
  }
}

function activityFilePath(taskId: string): string {
  return path.join(ACTIVITY_DIR, `${taskId}.json`);
}

function loadEntries(taskId: string): ActivityEntry[] {
  const filePath = activityFilePath(taskId);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }
}

function saveEntries(taskId: string, entries: ActivityEntry[]): void {
  ensureActivityDir();
  fs.writeFileSync(activityFilePath(taskId), JSON.stringify(entries, null, 2));
}

async function getHeadSha(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getFileDiff(worktreePath: string, filePath: string): Promise<string> {
  try {
    // Try tracked file diff first
    const { stdout } = await execFile(
      'git',
      ['diff', 'HEAD', '--', filePath],
      { cwd: worktreePath, maxBuffer: 5 * 1024 * 1024 },
    );
    if (stdout) return stdout;

    // Check if untracked (new file)
    try {
      await execFile('git', ['ls-files', '--error-unmatch', filePath], {
        cwd: worktreePath,
      });
      // File is tracked but has no diff — no changes
      return '';
    } catch {
      // File is untracked — generate synthetic diff
      const fullPath = path.resolve(worktreePath, filePath);
      if (!fs.existsSync(fullPath)) return '';
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const header = `--- /dev/null\n+++ b/${filePath}\n@@ -0,0 +1,${lines.length} @@\n`;
      return header + lines.map((l) => `+${l}`).join('\n') + '\n';
    }
  } catch {
    return '';
  }
}

async function getCommitMessage(worktreePath: string, sha: string): Promise<string> {
  try {
    const { stdout } = await execFile(
      'git',
      ['log', '-1', '--format=%s', sha],
      { cwd: worktreePath },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

async function getChangedFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], {
      cwd: worktreePath,
    });
    if (!stdout.trim()) return [];
    return stdout
      .trim()
      .split('\n')
      .map((line) => line.substring(3).trim())
      .filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

export function startWatching(
  taskId: string,
  worktreePath: string,
  mainWindow: BrowserWindow,
  claudeCallbacks?: ClaudeWatcherCallbacks,
): void {
  // Stop any existing watcher for this task
  stopWatching(taskId);

  const entries = loadEntries(taskId);

  const tw: TaskWatcher = {
    pollTimer: null as unknown as ReturnType<typeof setInterval>,
    entries,
    headSha: null,
    knownFiles: new Set<string>(),
  };

  // Get initial HEAD SHA and file state before starting the poll loop
  Promise.all([
    getHeadSha(worktreePath),
    getChangedFiles(worktreePath),
  ]).then(([sha, files]) => {
    tw.headSha = sha;
    for (const f of files) {
      tw.knownFiles.add(f);
    }
  });

  const poll = async () => {
    try {
      // 1. Check for new commit
      const currentSha = await getHeadSha(worktreePath);
      if (currentSha && tw.headSha && currentSha !== tw.headSha) {
        const commitMsg = await getCommitMessage(worktreePath, currentSha);
        const commitEntry: ActivityEntry = {
          id: randomUUID(),
          taskId,
          timestamp: Date.now(),
          type: 'commit',
          commitSha: currentSha,
          commitMessage: commitMsg,
        };
        tw.entries = [commitEntry];
        tw.headSha = currentSha;
        tw.knownFiles.clear();
        saveEntries(taskId, tw.entries);
        mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, commitEntry);
        return;
      }
      if (currentSha) {
        tw.headSha = currentSha;
      }

      // 2. Check for file changes via git status
      const changedFiles = await getChangedFiles(worktreePath);
      const currentSet = new Set(changedFiles);

      // Remove files no longer in git status
      for (const f of tw.knownFiles) {
        if (!currentSet.has(f)) {
          tw.knownFiles.delete(f);
        }
      }

      // Emit entries for new files
      for (const file of changedFiles) {
        if (!tw.knownFiles.has(file)) {
          tw.knownFiles.add(file);
          const diff = await getFileDiff(worktreePath, file);
          if (!diff) continue;

          const entry: ActivityEntry = {
            id: randomUUID(),
            taskId,
            timestamp: Date.now(),
            type: 'file_change',
            filePath: file,
            diff,
          };
          tw.entries.push(entry);
          saveEntries(taskId, tw.entries);
          mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, entry);
        }
      }
    } catch (err) {
      // Worktree may have been deleted or git state is broken — skip this cycle
      console.error(`[activity-watcher] poll error for task ${taskId}:`, err);
    }
  };

  tw.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  watchers.set(taskId, tw);

  // Also watch Claude Code JSONL session files
  startClaudeWatching(taskId, worktreePath, mainWindow, claudeCallbacks);
}

export function stopWatching(taskId: string): void {
  const tw = watchers.get(taskId);
  if (tw) {
    clearInterval(tw.pollTimer);
    watchers.delete(taskId);
  }
  stopClaudeWatching(taskId);
}

export function stopAllWatching(): void {
  for (const taskId of [...watchers.keys()]) {
    stopWatching(taskId);
  }
}

export function getActivityLog(taskId: string, worktreePath: string): ActivityEntry[] {
  const tw = watchers.get(taskId);
  const fileEntries = tw ? tw.entries : loadEntries(taskId);

  // Also include recent Claude JSONL entries (read directly from source)
  const claudeEntries = getRecentClaudeEntries(taskId, worktreePath);

  if (claudeEntries.length === 0) return fileEntries;

  // Merge and sort by timestamp
  return [...fileEntries, ...claudeEntries].sort((a, b) => a.timestamp - b.timestamp);
}

export function getLastChangedFile(taskId: string): string | null {
  const tw = watchers.get(taskId);
  const entries = tw ? tw.entries : loadEntries(taskId);
  for (let i = entries.length - 1; i >= 0; i--) {
    const filePath = entries[i].filePath;
    if (entries[i].type === 'file_change' && filePath) {
      return filePath;
    }
  }
  return null;
}

export function clearActivityLog(taskId: string): void {
  const tw = watchers.get(taskId);
  if (tw) {
    tw.entries = [];
  }
  saveEntries(taskId, []);
}
