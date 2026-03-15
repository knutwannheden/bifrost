import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';
import type { ActivityEntry } from '../shared/types';
import {
  type ClaudeWatcherCallbacks,
  getRecentClaudeEntries,
  startClaudeWatching,
  stopClaudeWatching,
} from './claude-watcher';
import { getDb } from './db';

const execFile = promisify(execFileCb);

const POLL_INTERVAL_MS = 2000;

const GIT_TIMEOUT_MS = 10000;

// biome-ignore lint/suspicious/noExplicitAny: row objects from DuckDB have dynamic fields
type Row = Record<string, any>;

function rowToEntry(row: Row): ActivityEntry {
  const entry: ActivityEntry = {
    id: row.id,
    taskId: row.task_id,
    timestamp: Number(row.timestamp),
    type: row.type,
  };
  if (row.file_path != null) entry.filePath = row.file_path;
  if (row.diff != null) entry.diff = row.diff;
  if (row.commit_sha != null) entry.commitSha = row.commit_sha;
  if (row.commit_message != null) entry.commitMessage = row.commit_message;
  if (row.claude_event_kind != null) entry.claudeEventKind = row.claude_event_kind;
  if (row.claude_text != null) entry.claudeText = row.claude_text;
  if (row.claude_tool_name != null) entry.claudeToolName = row.claude_tool_name;
  return entry;
}

function persistEntry(entry: ActivityEntry): void {
  getDb()
    .run(
      `INSERT INTO activity_entries (id, task_id, timestamp, type, file_path, diff, commit_sha,
        commit_message, claude_event_kind, claude_text, claude_tool_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.taskId,
        entry.timestamp,
        entry.type,
        entry.filePath ?? null,
        entry.diff ?? null,
        entry.commitSha ?? null,
        entry.commitMessage ?? null,
        entry.claudeEventKind ?? null,
        entry.claudeText ?? null,
        entry.claudeToolName ?? null,
      ],
    )
    .catch((err) => console.error('[activity-watcher] Failed to persist entry:', err));
}

function clearPersistedEntries(taskId: string): void {
  getDb()
    .run('DELETE FROM activity_entries WHERE task_id = ?', [taskId])
    .catch((err) => console.error('[activity-watcher] Failed to clear entries:', err));
}

function replacePersistedEntries(taskId: string, entries: ActivityEntry[]): void {
  (async () => {
    const db = getDb();
    await db.run('DELETE FROM activity_entries WHERE task_id = ?', [taskId]);
    for (const entry of entries) {
      await db.run(
        `INSERT INTO activity_entries (id, task_id, timestamp, type, file_path, diff, commit_sha,
          commit_message, claude_event_kind, claude_text, claude_tool_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.id,
          entry.taskId,
          entry.timestamp,
          entry.type,
          entry.filePath ?? null,
          entry.diff ?? null,
          entry.commitSha ?? null,
          entry.commitMessage ?? null,
          entry.claudeEventKind ?? null,
          entry.claudeText ?? null,
          entry.claudeToolName ?? null,
        ],
      );
    }
  })().catch((err) => console.error('[activity-watcher] Failed to replace entries:', err));
}

interface TaskWatcher {
  pollTimer: ReturnType<typeof setInterval>;
  entries: ActivityEntry[];
  headSha: string | null;
  knownFiles: Set<string>;
  polling: boolean;
}

const watchers = new Map<string, TaskWatcher>();

async function loadEntriesAsync(taskId: string): Promise<ActivityEntry[]> {
  const reader = await getDb().runAndReadAll('SELECT * FROM activity_entries WHERE task_id = ? ORDER BY timestamp', [
    taskId,
  ]);
  return reader.getRowObjectsJS().map(rowToEntry);
}

async function getHeadSha(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function getFileDiff(worktreePath: string, filePath: string): Promise<string> {
  try {
    // Try tracked file diff first
    const { stdout } = await execFile('git', ['diff', 'HEAD', '--', filePath], {
      cwd: worktreePath,
      maxBuffer: 5 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    if (stdout) return stdout;

    // Check if untracked (new file)
    try {
      await execFile('git', ['ls-files', '--error-unmatch', filePath], {
        cwd: worktreePath,
        timeout: GIT_TIMEOUT_MS,
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
      return `${header + lines.map((l) => `+${l}`).join('\n')}\n`;
    }
  } catch {
    return '';
  }
}

async function getCommitMessage(worktreePath: string, sha: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['log', '-1', '--format=%s', sha], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function getChangedFiles(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFile('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
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
  sessionId?: string,
): void {
  // Stop any existing watcher for this task
  stopWatching(taskId);

  const tw: TaskWatcher = {
    pollTimer: null as unknown as ReturnType<typeof setInterval>,
    entries: [],
    headSha: null,
    knownFiles: new Set<string>(),
    polling: false,
  };

  // Load persisted entries and initial git state before starting the poll loop
  Promise.all([loadEntriesAsync(taskId), getHeadSha(worktreePath), getChangedFiles(worktreePath)]).then(
    ([entries, sha, files]) => {
      tw.entries = entries;
      tw.headSha = sha;
      for (const f of files) {
        tw.knownFiles.add(f);
      }
    },
  );

  const poll = async () => {
    if (tw.polling) return; // Previous poll still running — skip this cycle
    tw.polling = true;
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
        // Replace all entries with just the commit entry
        replacePersistedEntries(taskId, tw.entries);
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
          // Incremental insert — no full rewrite
          persistEntry(entry);
          mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, entry);
        }
      }
    } catch (err) {
      // Worktree may have been deleted or git state is broken — skip this cycle
      console.error(`[activity-watcher] poll error for task ${taskId}:`, err);
    } finally {
      tw.polling = false;
    }
  };

  tw.pollTimer = setInterval(poll, POLL_INTERVAL_MS);
  watchers.set(taskId, tw);

  // Also watch Claude Code JSONL session files
  startClaudeWatching(taskId, worktreePath, mainWindow, claudeCallbacks, sessionId);
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

export async function getActivityLog(taskId: string, worktreePath: string): Promise<ActivityEntry[]> {
  const tw = watchers.get(taskId);
  // Use in-memory entries from watcher, or load from DB for cold reads
  const fileEntries = tw ? tw.entries : await loadEntriesAsync(taskId);

  // Also include recent Claude JSONL entries (read directly from source)
  const claudeEntries = getRecentClaudeEntries(taskId, worktreePath);

  if (claudeEntries.length === 0) return fileEntries;

  // Merge and sort by timestamp
  return [...fileEntries, ...claudeEntries].sort((a, b) => a.timestamp - b.timestamp);
}

export function getLastChangedFile(taskId: string): string | null {
  const tw = watchers.get(taskId);
  const entries = tw ? tw.entries : [];
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
  clearPersistedEntries(taskId);
}
