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
import { type FsWatchHandle, watchDir } from './fs-watcher';

const execFile = promisify(execFileCb);

// Filesystem watching drives the hot path; this slow poll is only a safety net
// for events the OS may drop (FSEvents/inotify overflow under bursty load).
const SAFETY_POLL_INTERVAL_MS = 15000;
const GIT_TIMEOUT_MS = 10000;

// Heavy/uninteresting subtrees we never need change signals from. `.git` is
// excluded here and watched separately via the resolved gitdir (below), because
// a commit on a worktree touches the gitdir's `logs/HEAD`, not the worktree.
const WORKTREE_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/coverage/**',
];

// The gitdir's `objects/` sees heavy pack churn that tells us nothing the
// `logs/HEAD`/refs/index changes don't; ignore it to avoid needless re-polls.
const GITDIR_IGNORE = ['**/objects/**'];

/**
 * Resolve a worktree's actual git directory. For a linked worktree, `.git` is a
 * file containing `gitdir: <path>` pointing at `<main-repo>/.git/worktrees/<name>`;
 * for a normal checkout it's the `.git` directory itself. Returns null if it
 * can't be resolved (the safety poll still covers commit detection in that case).
 */
function resolveGitDir(worktreePath: string): string | null {
  const dotGit = path.join(worktreePath, '.git');
  try {
    const st = fs.statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    const content = fs.readFileSync(dotGit, 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) return null;
    const gitdir = match[1].trim();
    return path.isAbsolute(gitdir) ? gitdir : path.resolve(worktreePath, gitdir);
  } catch {
    return null;
  }
}

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
    .prepare<unknown[], Row>('SELECT * FROM activity_entries WHERE task_id = ? ORDER BY timestamp')
    .all(taskId)
    .map(rowToEntry);
}

interface TaskWatcher {
  /** Safety-net poll; the filesystem watches below drive the hot path. */
  safetyTimer: ReturnType<typeof setInterval>;
  worktreeWatch: FsWatchHandle | null;
  gitdirWatch: FsWatchHandle | null;
  entries: ActivityEntry[];
  headSha: string | null;
  knownFiles: Set<string>;
  polling: boolean;
  /** A change fired while a poll was in flight — re-run once it finishes. */
  pollPending: boolean;
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
    safetyTimer: null as unknown as ReturnType<typeof setInterval>,
    worktreeWatch: null,
    gitdirWatch: null,
    entries,
    headSha: null,
    knownFiles: new Set<string>(),
    polling: false,
    pollPending: false,
  };

  // Get initial HEAD SHA and file state before starting the poll loop
  Promise.all([getHeadSha(worktreePath), getChangedFiles(worktreePath)]).then(([sha, files]) => {
    tw.headSha = sha;
    for (const f of files) {
      tw.knownFiles.add(f);
    }
  });

  const poll = async () => {
    if (tw.polling) {
      // A poll is in flight; remember to re-run once it finishes so a change
      // (especially a commit) that lands mid-poll isn't stranded until the
      // slow safety poll.
      tw.pollPending = true;
      return;
    }
    tw.polling = true;
    tw.pollPending = false;
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
      // A change fired during the poll above (including via the commit branch's
      // early return) — run one more pass to pick it up. In `finally` so it
      // covers every exit path.
      if (tw.pollPending) {
        tw.pollPending = false;
        void poll();
      }
    }
  };

  // Slow safety net — the filesystem watches below handle the low-latency path.
  tw.safetyTimer = setInterval(poll, SAFETY_POLL_INTERVAL_MS);
  watchers.set(taskId, tw);

  // Event-driven: re-poll when worktree files change (file edits) or the gitdir
  // changes (commits). `subscribe` is async; if this task's watcher is replaced
  // or stopped before it resolves, close the orphaned handle immediately.
  const trigger = (): void => {
    void poll();
  };
  watchDir(worktreePath, trigger, { ignore: WORKTREE_IGNORE })
    .then((handle) => {
      if (watchers.get(taskId) === tw) tw.worktreeWatch = handle;
      else void handle.close();
    })
    .catch((err) => {
      console.error(`[activity-watcher] failed to watch worktree for task ${taskId}:`, err);
    });

  const gitdir = resolveGitDir(worktreePath);
  if (gitdir) {
    watchDir(gitdir, trigger, { ignore: GITDIR_IGNORE })
      .then((handle) => {
        if (watchers.get(taskId) === tw) tw.gitdirWatch = handle;
        else void handle.close();
      })
      .catch((err) => {
        console.error(`[activity-watcher] failed to watch gitdir for task ${taskId}:`, err);
      });
  }

  // Also watch Claude Code JSONL session files
  startClaudeWatching(taskId, worktreePath, mainWindow, claudeCallbacks, sessionId);
}

export function stopWatching(taskId: string): void {
  const tw = watchers.get(taskId);
  if (tw) {
    clearInterval(tw.safetyTimer);
    void tw.worktreeWatch?.close();
    void tw.gitdirWatch?.close();
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
