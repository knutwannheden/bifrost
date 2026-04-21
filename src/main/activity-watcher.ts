import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

// biome-ignore lint/suspicious/noExplicitAny: row objects from SQLite have dynamic fields
type Row = Record<string, any>;

function rowToEntry(row: Row): ActivityEntry {
  const entry: ActivityEntry = {
    id: row.id,
    taskId: row.task_id,
    timestamp: row.timestamp,
    type: row.type,
  };
  if (row.file_path != null) entry.filePath = row.file_path;
  if (row.commit_sha != null) entry.commitSha = row.commit_sha;
  if (row.commit_message != null) entry.commitMessage = row.commit_message;
  if (row.claude_event_kind != null) entry.claudeEventKind = row.claude_event_kind;
  if (row.claude_text != null) entry.claudeText = row.claude_text;
  if (row.claude_tool_name != null) entry.claudeToolName = row.claude_tool_name;
  return entry;
}

const INSERT_SQL = `INSERT INTO activity_entries (id, task_id, timestamp, type, file_path, commit_sha,
  commit_message, claude_event_kind, claude_text, claude_tool_name)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function persistEntry(entry: ActivityEntry): void {
  getDb()
    .prepare(INSERT_SQL)
    .run(
      entry.id,
      entry.taskId,
      entry.timestamp,
      entry.type,
      entry.filePath ?? null,
      entry.commitSha ?? null,
      entry.commitMessage ?? null,
      entry.claudeEventKind ?? null,
      entry.claudeText ?? null,
      entry.claudeToolName ?? null,
    );
}

function clearPersistedEntries(taskId: string): void {
  getDb().prepare('DELETE FROM activity_entries WHERE task_id = ?').run(taskId);
}

function replacePersistedEntries(taskId: string, entries: ActivityEntry[]): void {
  const d = getDb();
  const replace = d.transaction(() => {
    d.prepare('DELETE FROM activity_entries WHERE task_id = ?').run(taskId);
    const stmt = d.prepare(INSERT_SQL);
    for (const entry of entries) {
      stmt.run(
        entry.id,
        entry.taskId,
        entry.timestamp,
        entry.type,
        entry.filePath ?? null,
        entry.commitSha ?? null,
        entry.commitMessage ?? null,
        entry.claudeEventKind ?? null,
        entry.claudeText ?? null,
        entry.claudeToolName ?? null,
      );
    }
  });
  replace();
}

function loadEntries(taskId: string): ActivityEntry[] {
  return getDb()
    .prepare('SELECT * FROM activity_entries WHERE task_id = ? ORDER BY timestamp')
    .all(taskId)
    .map(rowToEntry);
}

interface TaskWatcher {
  pollTimer: ReturnType<typeof setInterval>;
  entries: ActivityEntry[];
  headSha: string | null;
  knownFiles: Set<string>;
  polling: boolean;
}

const watchers = new Map<string, TaskWatcher>();

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
    const { stdout } = await execFile('git', ['--no-optional-locks', 'status', '--porcelain'], {
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

  // Load persisted entries synchronously
  const entries = loadEntries(taskId);

  const tw: TaskWatcher = {
    pollTimer: null as unknown as ReturnType<typeof setInterval>,
    entries,
    headSha: null,
    knownFiles: new Set<string>(),
    polling: false,
  };

  // Get initial HEAD SHA and file state before starting the poll loop
  Promise.all([getHeadSha(worktreePath), getChangedFiles(worktreePath)]).then(([sha, files]) => {
    tw.headSha = sha;
    for (const f of files) {
      tw.knownFiles.add(f);
    }
  });

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

          const entry: ActivityEntry = {
            id: randomUUID(),
            taskId,
            timestamp: Date.now(),
            type: 'file_change',
            filePath: file,
          };
          tw.entries.push(entry);
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
  clearPersistedEntries(taskId);
}

export async function getFileDiffOnDemand(worktreePath: string, filePath: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['--no-optional-locks', 'diff', 'HEAD', '--', filePath], {
      cwd: worktreePath,
      maxBuffer: 5 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  } catch {
    return '';
  }
}
