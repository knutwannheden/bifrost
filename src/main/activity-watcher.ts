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
import { type FsWatchHandle, watchDir } from './fs-watcher';

const execFile = promisify(execFileCb);

// Filesystem watching drives the hot path; this slow poll is only a safety net
// for events the OS may drop (FSEvents/inotify overflow under bursty load).
const SAFETY_POLL_INTERVAL_MS = 15000;
const GIT_TIMEOUT_MS = 10000;

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
type UnusedRow = Record<string, any>;

interface TaskWatcher {
  /** Safety-net poll. The gitdir watch drives the hot path. */
  safetyTimer: ReturnType<typeof setInterval>;
  gitdirWatch: FsWatchHandle | null;
  entries: ActivityEntry[];
  headSha: string | null;
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

export function startWatching(
  taskId: string,
  worktreePath: string,
  mainWindow: BrowserWindow,
  claudeCallbacks?: ClaudeWatcherCallbacks,
  sessionId?: string,
): void {
  // Stop any existing watcher for this task
  stopWatching(taskId);

  // The log covers the watcher's own lifetime; nothing of it is kept on disk.
  const entries: ActivityEntry[] = [];

  const tw: TaskWatcher = {
    safetyTimer: null as unknown as ReturnType<typeof setInterval>,
    gitdirWatch: null,
    entries,
    headSha: null,
    polling: false,
    pollPending: false,
  };

  getHeadSha(worktreePath).then((sha) => {
    tw.headSha = sha;
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
        mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, commitEntry);
      }
      if (currentSha) tw.headSha = currentSha;
    } catch (err) {
      // Worktree may have been deleted or git state is broken — skip this cycle
      console.error(`[activity-watcher] poll error for task ${taskId}:`, err);
    } finally {
      tw.polling = false;
      // A change fired during the poll above — run one more pass to pick it up.
      // In `finally` so it covers every exit path.
      if (tw.pollPending) {
        tw.pollPending = false;
        void poll();
      }
    }
  };

  // Slow safety net — the gitdir watch below handles the low-latency path.
  tw.safetyTimer = setInterval(poll, SAFETY_POLL_INTERVAL_MS);
  watchers.set(taskId, tw);

  // Commits are seen through the gitdir, whose `logs/HEAD` a commit on the
  // worktree touches. `subscribe` is async; if this task's watcher is replaced
  // or stopped before it resolves, close the orphaned handle immediately.
  const trigger = (): void => {
    void poll();
  };
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
  const commitEntries = tw ? tw.entries : [];

  // Also include recent Claude JSONL entries (read directly from source)
  const claudeEntries = getRecentClaudeEntries(taskId, worktreePath);

  if (claudeEntries.length === 0) return commitEntries;

  // Merge and sort by timestamp
  return [...commitEntries, ...claudeEntries].sort((a, b) => a.timestamp - b.timestamp);
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
