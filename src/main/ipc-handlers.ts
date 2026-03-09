import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';

const execFile = promisify(execFileCb);

import { IPC, IPC_STREAM } from '../shared/ipc-channels';
import { generateTaskName } from '../shared/name-generator';
import type {
  ActivityEntry,
  AddRepoParams,
  BifrostConfig,
  CaptureContextParams,
  CreateTaskParams,
  PermissionDecision,
  Repo,
  Task,
} from '../shared/types';
import { clearActivityLog, getActivityLog, getLastChangedFile, startWatching, stopWatching } from './activity-watcher';
import { getApiPort, getSessionMtime, isSessionStale } from './bifrost-api';
import { scanClaudeSessions } from './claude-session-scanner';
import { getRecentClaudeEntries, getTokenUsageData } from './claude-watcher';
import { loadConfig, saveConfig } from './config';
import { findTranscriptMatch, getClaudeJsonlPath, loadPersistedContexts, store as storeContext } from './context-store';
import { getDiff, getDiffStats, getFileStatuses } from './diff-service';
import { getGitLog } from './git-log-service';
import { scanRecentRepos } from './history-scanner';
import { openFileInIde, openInIde } from './ide-launcher';
import { checkIntegration, installIntegration } from './integration-installer';
import { createNote, deleteNote, listNotes, updateNote } from './note-store';
import { setActiveTaskId } from './notification-service';
import { cancelTaskRequests, resolveRequest, setWorktreePathResolver } from './permission-manager';
import { addRepo, getRemotes, getRepoBranches, removeRepo } from './repo-manager';
import {
  cancelReview,
  deleteReview,
  getReviewSessionId,
  listReviews,
  loadReview,
  runReview,
  saveReview,
  watchReviewFile,
} from './review-service';
import {
  createSession,
  createShellSession,
  drainSessionBuffer,
  killSession,
  resizeSession,
  writeToSession,
} from './session-manager';
import { disconnectSlack, restartPolling, startOAuth } from './slack-service';
import { getStats } from './stats-service';
import {
  getSupervisorState,
  initSupervisor,
  openItem,
  pauseItem,
  removeItem,
  resumeItem,
  setSupervisorConcurrency,
  startSupervisor,
  stopSupervisor,
} from './supervisor-service';
import { loadTasks, saveTasks } from './task-store';
import { createWorktree, createWorktreeFromPr, removeWorktree, restoreWorktree } from './worktree-manager';

// In-memory task list, synced to disk
let tasks: Task[] = [];

// Module-level reference set by registerIpcHandlers(), used by createTaskCore()
let _claudeCallbacks: { onSummary: (taskId: string, summary: string) => void } | null = null;

// Tasks whose sessions are deferred until their tab is activated
const pendingRestore = new Set<string>();

export function getTasks(): Task[] {
  return tasks;
}

export function getTask(taskId: string): Task {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

export function updateTask(taskId: string, updates: Partial<Task>): Task {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) throw new Error(`Task not found: ${taskId}`);
  tasks[idx] = { ...tasks[idx], ...updates };
  saveTasks(tasks);
  return tasks[idx];
}

/**
 * Resolve the effective base branch for diff/review comparison.
 * Tries repo.defaultBranch (preferring remote-tracking refs), then origin/HEAD,
 * then origin/main or origin/master as last resort. All local operations, no network.
 */
async function resolveBaseBranch(task: Task): Promise<string | undefined> {
  // Wrap with a timeout so we never block the UI indefinitely
  const result = await Promise.race([
    resolveBaseBranchInner(task),
    new Promise<undefined>((resolve) => setTimeout(resolve, 8000)),
  ]);
  return result;
}

async function resolveBaseBranchInner(task: Task): Promise<string | undefined> {
  // Try repo's configured default branch (remote-tracking refs preferred for freshness)
  const config = loadConfig();
  const repo = config.repos.find((r: Repo) => r.id === task.repoId);
  if (repo?.defaultBranch) {
    for (const candidate of [`origin/${repo.defaultBranch}`, `upstream/${repo.defaultBranch}`, repo.defaultBranch]) {
      try {
        await execFile('git', ['rev-parse', '--verify', candidate], { cwd: task.worktreePath, timeout: 5000 });
        return candidate;
      } catch {
        /* ref doesn't exist */
      }
    }
  }

  // Fallback: origin/HEAD
  try {
    const { stdout } = await execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: task.worktreePath,
      timeout: 5000,
    });
    const branch = stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (branch) return `origin/${branch}`;
  } catch {
    /* origin/HEAD not set */
  }

  // Last resort: origin/main or origin/master
  for (const candidate of ['main', 'master']) {
    try {
      await execFile('git', ['rev-parse', '--verify', `origin/${candidate}`], {
        cwd: task.worktreePath,
        timeout: 5000,
      });
      return `origin/${candidate}`;
    } catch {
      /* doesn't exist */
    }
  }

  return undefined;
}

async function destroyTask(taskId: string): Promise<void> {
  cancelTaskRequests(taskId);
  const task = getTask(taskId);
  stopWatching(taskId);
  if (task.status === 'running') {
    killSession(taskId);
  }
  if (!task.inPlace && fs.existsSync(task.worktreePath)) {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === task.repoId);
    if (repo) {
      try {
        await removeWorktree(repo.path, task.worktreePath);
      } catch {
        // Worktree may already be removed
      }
    }
  }
  tasks = tasks.filter((t) => t.id !== taskId);
  saveTasks(tasks);
}

export async function createTaskCore(params: CreateTaskParams, mainWindow: BrowserWindow): Promise<Task> {
  const config = loadConfig();
  let repo: Repo | undefined;

  if (params.repoPath) {
    const input = params.repoPath;
    // Try matching as GitHub path (e.g. "org/repo")
    repo = config.repos.find((r: Repo) => r.githubPath === input);
    if (!repo) {
      // Resolve as filesystem path — find existing or auto-add
      const resolved = path.resolve(input.replace(/^~(\/|$)/, `${os.homedir()}$1`));
      repo = config.repos.find((r: Repo) => r.path === resolved);
      if (!repo) {
        repo = await addRepo({ type: 'local', path: resolved });
        config.repos.push(repo);
        saveConfig(config);
      }
    }
  } else {
    repo = config.repos.find((r: Repo) => r.id === params.repoId);
  }
  if (!repo) throw new Error(`Repo not found: ${params.repoId ?? params.repoPath}`);

  const name = params.branchName || params.name || generateTaskName();

  let worktreePath: string;
  let branch = params.branch;
  let inPlace = false;

  if (params.inPlace) {
    const conflict = tasks.find((t) => t.status !== 'archived' && t.worktreePath === repo.path);
    if (conflict) {
      throw new Error(`An active task "${conflict.name}" already uses the main worktree for this repo`);
    }
    worktreePath = repo.path;
    const { stdout } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo.path, timeout: 5000 });
    branch = stdout.trim();
    inPlace = true;
  } else {
    worktreePath = params.prInfo
      ? await createWorktreeFromPr(repo.path, name, params.prInfo)
      : await createWorktree(repo.path, name, params.branch, params.branchName);
  }

  const taskId = randomUUID();
  createSession(taskId, worktreePath, mainWindow, {
    taskId,
    apiPort: getApiPort() ?? undefined,
    permissionMode: config.permissionMode,
    agentTeams: config.agentTeams,
    prompt: params.prompt,
  });

  const task: Task = {
    id: taskId,
    name,
    repoId: repo.id,
    branch,
    worktreePath,
    status: 'running',
    hasUnread: false,
    createdAt: Date.now(),
    ...(inPlace && { inPlace: true }),
    ...(params.prompt ? { summary: params.prompt } : {}),
  };

  tasks.push(task);
  saveTasks(tasks);

  if (!_claudeCallbacks) throw new Error('IPC handlers not yet initialized');
  startWatching(task.id, worktreePath, mainWindow, _claudeCallbacks, task.sessionId);

  return task;
}

function restoreTaskSession(taskId: string, mainWindow: BrowserWindow): void {
  pendingRestore.delete(taskId);
  const task = getTask(taskId);
  const config = loadConfig();

  createSession(taskId, task.worktreePath, mainWindow, {
    resumeSessionId: task.sessionId,
    taskId,
    apiPort: getApiPort() ?? undefined,
    permissionMode: config.permissionMode,
    agentTeams: config.agentTeams,
    onResumeFailed: task.sessionId ? () => updateTask(taskId, { sessionId: undefined }) : undefined,
  });

  if (!_claudeCallbacks) throw new Error('IPC handlers not yet initialized');
  startWatching(taskId, task.worktreePath, mainWindow, _claudeCallbacks, task.sessionId);
}

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Load persisted context entries from disk
  loadPersistedContexts();

  // Load persisted tasks on startup, restore sessions for previously-running tasks
  const persisted = loadTasks();
  const tasksToRestore = persisted.filter((t) => t.status === 'running');

  tasks = persisted.map((t) => (t.status === 'running' ? { ...t, status: 'stopped' as const } : t));

  // Permission manager: provide worktree path resolver
  setWorktreePathResolver((taskId) => getTask(taskId).worktreePath);

  // Claude watcher callbacks
  const claudeCallbacks = {
    onSummary: (taskId: string, summary: string) => {
      try {
        updateTask(taskId, { summary });
        mainWindow.webContents.send(IPC_STREAM.TASK_SUMMARY, taskId, summary);
      } catch {
        /* task may have been deleted */
      }
    },
  };
  _claudeCallbacks = claudeCallbacks;

  // Mark previously-running tasks as running and defer session creation until tab activation
  for (const task of tasksToRestore) {
    if (fs.existsSync(task.worktreePath)) {
      // Check if stored sessionId is stale; if so, clear it so user can select a session
      if (task.sessionId && isSessionStale(task.worktreePath, task.sessionId)) {
        const idx = tasks.findIndex((t) => t.id === task.id);
        if (idx !== -1) {
          tasks[idx] = { ...tasks[idx], sessionId: undefined };
        }
      }

      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], status: 'running', hasUnread: false };
      }

      pendingRestore.add(task.id);
    }
  }

  saveTasks(tasks);

  // Config
  ipcMain.handle(IPC.LOAD_CONFIG, () => loadConfig());
  ipcMain.handle(IPC.SAVE_CONFIG, (_event, config: BifrostConfig) => {
    saveConfig(config);
    restartPolling(mainWindow);
  });
  ipcMain.handle(IPC.SET_IDE, (_event, ide: 'code' | 'idea' | 'zed') => {
    const config = loadConfig();
    config.ide = ide;
    saveConfig(config);
  });

  // Repos
  ipcMain.handle(IPC.ADD_REPO, async (_event, params: AddRepoParams) => {
    const repo = await addRepo(params);
    const config = loadConfig();
    config.repos.push(repo);
    saveConfig(config);
    return repo;
  });

  ipcMain.handle(IPC.REMOVE_REPO, (_event, repoId: string) => {
    const config = loadConfig();
    const updated = removeRepo(repoId, config);
    saveConfig(updated);
  });

  ipcMain.handle(IPC.LIST_REPOS, () => {
    const config = loadConfig();
    return config.repos;
  });

  ipcMain.handle(IPC.GET_REPO_BRANCHES, async (_event, repoId: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    return getRepoBranches(repo.path);
  });

  ipcMain.handle(IPC.GET_CURRENT_BRANCH, async (_event, repoId: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    const { stdout } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo.path });
    return stdout.trim();
  });

  ipcMain.handle(IPC.GET_RECENT_REPOS, () => {
    const config = loadConfig();
    const excludePaths = new Set(config.repos.map((r: Repo) => r.path));
    return scanRecentRepos(excludePaths);
  });

  // Dev terminal sessions (taskId -> dev sessionId)
  const devSessions = new Map<string, string>();
  // Review terminal sessions (taskId -> review PTY sessionId)
  const reviewSessions = new Map<string, string>();

  // Tasks
  ipcMain.handle(IPC.CREATE_TASK, async (_event, params: CreateTaskParams) => {
    return createTaskCore(params, mainWindow);
  });

  ipcMain.handle(IPC.CLOSE_TASK, async (_event, taskId: string) => {
    killSession(taskId);
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    const reviewPtyId = reviewSessions.get(taskId);
    if (reviewPtyId) {
      killSession(reviewPtyId);
      reviewSessions.delete(taskId);
    }
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.STOP_TASK, (_event, taskId: string) => {
    const task = getTask(taskId);
    if (task.status === 'running') {
      cancelTaskRequests(taskId);
      killSession(taskId);
    }
    return updateTask(taskId, { status: 'stopped' });
  });

  ipcMain.handle(IPC.ARCHIVE_TASK, async (_event, taskId: string) => {
    cancelTaskRequests(taskId);
    const task = getTask(taskId);

    stopWatching(taskId);

    // Kill dev terminal if any
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    const reviewPtyId = reviewSessions.get(taskId);
    if (reviewPtyId) {
      killSession(reviewPtyId);
      reviewSessions.delete(taskId);
    }

    // Kill session if still running
    if (task.status === 'running') {
      killSession(taskId);
    }

    // Remove worktree but keep the branch
    if (!task.isExternal && !task.inPlace && fs.existsSync(task.worktreePath)) {
      const config = loadConfig();
      const repo = config.repos.find((r: Repo) => r.id === task.repoId);
      if (repo) {
        try {
          await removeWorktree(repo.path, task.worktreePath);
        } catch {
          // Worktree may already be removed
        }
      }
    }

    return updateTask(taskId, {
      status: 'archived',
      archivedAt: Date.now(),
    });
  });

  ipcMain.handle(IPC.IS_WORKTREE_DIRTY, async (_event, taskId: string) => {
    const task = getTask(taskId);
    // We don't own external or in-place worktrees — skip check
    if (task.isExternal || task.inPlace) return false;
    if (!fs.existsSync(task.worktreePath)) return false;
    try {
      const { stdout } = await execFile('git', ['status', '--porcelain'], {
        cwd: task.worktreePath,
        timeout: 5000,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC.REOPEN_TASK, async (_event, taskId: string) => {
    const task = getTask(taskId);
    let worktreePath = task.worktreePath;
    let branch = task.branch;

    // Restore worktree from branch if it was removed during archive
    if (!fs.existsSync(worktreePath)) {
      if (task.isExternal || task.inPlace) {
        throw new Error(`Directory no longer exists: ${worktreePath}`);
      }
      const config = loadConfig();
      const repo = config.repos.find((r: Repo) => r.id === task.repoId);
      if (!repo) throw new Error(`Repo not found: ${task.repoId}`);
      worktreePath = await restoreWorktree(repo.path, task.name);
    }

    // Re-detect current branch for in-place tasks (user may have switched)
    if (task.inPlace) {
      try {
        const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
        branch = stdout.trim();
      } catch {
        // ignore — keep existing branch
      }
    }

    const reopenConfig = loadConfig();

    // Check if stored sessionId is stale; if so, clear it so user can select a session
    let resumeSessionId = task.sessionId;
    if (resumeSessionId && isSessionStale(worktreePath, resumeSessionId)) {
      resumeSessionId = undefined;
      updateTask(taskId, { sessionId: undefined });
    }

    createSession(taskId, worktreePath, mainWindow, {
      resumeSessionId,
      taskId,
      apiPort: getApiPort() ?? undefined,
      permissionMode: reopenConfig.permissionMode,
      agentTeams: reopenConfig.agentTeams,
      onResumeFailed: resumeSessionId ? () => updateTask(taskId, { sessionId: undefined }) : undefined,
    });

    // Restart file watcher
    startWatching(taskId, worktreePath, mainWindow, claudeCallbacks, resumeSessionId);

    return updateTask(taskId, {
      worktreePath,
      branch,
      status: 'running',
      hasUnread: false,
      archivedAt: undefined,
    });
  });

  ipcMain.handle(IPC.RENAME_TASK, (_event, taskId: string, name: string) => {
    return updateTask(taskId, { name });
  });

  ipcMain.handle(IPC.DELETE_TASK, async (_event, taskId: string) => {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    const reviewPtyId = reviewSessions.get(taskId);
    if (reviewPtyId) {
      killSession(reviewPtyId);
      reviewSessions.delete(taskId);
    }
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.LIST_TASKS, () => {
    return tasks;
  });

  ipcMain.handle(IPC.REORDER_TASKS, (_event, taskIds: string[]) => {
    const idSet = new Set(taskIds);
    const reordered = taskIds.map((id) => tasks.find((t) => t.id === id)!).filter(Boolean);
    let ri = 0;
    tasks = tasks.map((t) => (idSet.has(t.id) ? reordered[ri++] : t));
    saveTasks(tasks);
  });

  ipcMain.handle(IPC.GET_SESSION_MTIMES, () => {
    const result: Record<string, number> = {};
    for (const task of tasks) {
      const mtime = getSessionMtime(task.worktreePath, task.sessionId);
      if (mtime != null) result[task.id] = mtime;
    }
    return result;
  });

  ipcMain.handle(IPC.CREATE_DEV_TERMINAL, (_event, taskId: string) => {
    const task = getTask(taskId);
    // Kill existing dev session if any
    const existing = devSessions.get(taskId);
    if (existing) killSession(existing);

    const devSessionId = `${taskId}-dev`;
    createShellSession(devSessionId, task.worktreePath, mainWindow, { taskId });
    devSessions.set(taskId, devSessionId);
    return devSessionId;
  });

  ipcMain.handle(IPC.CLOSE_DEV_TERMINAL, (_event, taskId: string) => {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
  });

  // Terminal sessions
  ipcMain.handle(IPC.WRITE_TO_SESSION, (_event, sessionId: string, data: string) => {
    writeToSession(sessionId, data);
  });

  ipcMain.handle(IPC.RESIZE_SESSION, (_event, sessionId: string, cols: number, rows: number) => {
    resizeSession(sessionId, cols, rows);
  });

  ipcMain.handle(IPC.DRAIN_SESSION_BUFFER, (_event, sessionId: string) => {
    return drainSessionBuffer(sessionId);
  });

  // Diff
  ipcMain.handle(IPC.GET_DIFF, async (_event, taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getDiff(task.worktreePath, baseBranch, scope);
  });

  // File statuses (staged/unstaged/committed/untracked)
  ipcMain.handle(IPC.GET_FILE_STATUSES, async (_event, taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getFileStatuses(task.worktreePath, baseBranch);
  });

  // Diff stats
  ipcMain.handle(IPC.GET_DIFF_STATS, async (_event, taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getDiffStats(task.worktreePath, baseBranch, scope);
  });

  // Git log
  ipcMain.handle(IPC.GET_GIT_LOG, async (_event, taskId: string) => {
    const task = getTask(taskId);
    // task.branch is the base branch the worktree was forked from
    const baseBranch = task.branch || undefined;
    return getGitLog(task.worktreePath, baseBranch);
  });

  // PR URL
  ipcMain.handle(IPC.GET_PR_URL, async (_event, taskId: string) => {
    const task = getTask(taskId);
    try {
      const { stdout } = await execFile('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], {
        cwd: task.worktreePath,
        timeout: 10000,
        killSignal: 'SIGKILL',
      });
      const url = stdout.trim();
      return url || null;
    } catch {
      return null;
    }
  });

  // Shell
  ipcMain.handle(IPC.OPEN_URL, (_event, url: string) => {
    // file:// URLs → open in configured IDE
    if (/^file:\/\//i.test(url)) {
      try {
        const parsed = new URL(url);
        const filePath = decodeURIComponent(parsed.pathname);
        const line =
          parseInt(parsed.hash.replace(/^#L?/, ''), 10) ||
          parseInt(parsed.searchParams.get('line') ?? '', 10) ||
          undefined;
        // Match file path to a task worktree so the IDE opens in the right window
        const worktree = getTasks().find(
          (t) => t.worktreePath && filePath.startsWith(`${t.worktreePath}/`),
        )?.worktreePath;
        return openFileInIde(filePath, line, worktree);
      } catch {
        return;
      }
    }
    if (!/^https?:\/\//i.test(url)) return;
    return shell.openExternal(url);
  });

  // IDE
  ipcMain.handle(IPC.OPEN_IN_IDE, (_event, worktreePath: string, filePath?: string, line?: number) => {
    return openInIde(worktreePath, undefined, filePath, line);
  });

  ipcMain.handle(IPC.GET_LAST_CHANGED_FILE, (_event, taskId: string) => {
    return getLastChangedFile(taskId);
  });

  // Activity Log
  ipcMain.handle(IPC.GET_ACTIVITY_LOG, (_event, taskId: string) => {
    const task = getTask(taskId);
    return getActivityLog(taskId, task.worktreePath);
  });

  ipcMain.handle(IPC.CLEAR_ACTIVITY_LOG, (_event, taskId: string) => {
    clearActivityLog(taskId);
  });

  // Token Usage
  ipcMain.handle(IPC.GET_TOKEN_USAGE, (_event, taskId: string) => {
    const task = getTask(taskId);
    return getTokenUsageData(task.worktreePath, task.sessionId);
  });

  // Terminal title
  ipcMain.handle(IPC.SET_TERMINAL_TITLE, (_event, taskId: string, title: string) => {
    updateTask(taskId, { terminalTitle: title });
    mainWindow.setTitle(`BIFROST — ${title}`);
  });

  // Context capture
  ipcMain.handle(IPC.CAPTURE_CONTEXT, (_event, params: CaptureContextParams) => {
    const id = storeContext(params);
    clipboard.writeText(`[Bifrost #${id}]`);
    return id;
  });

  ipcMain.handle(IPC.FIND_TRANSCRIPT_MATCH, (_event, worktreePath: string, searchText: string) => {
    const jsonlPath = getClaudeJsonlPath(worktreePath);
    if (!jsonlPath) return null;
    const match = findTranscriptMatch(jsonlPath, searchText);
    if (!match) return null;
    return { jsonlPath, ...match };
  });

  ipcMain.handle(IPC.GET_API_PORT, () => {
    return getApiPort();
  });

  // Claude sessions
  ipcMain.handle(IPC.LIST_CLAUDE_SESSIONS, () => {
    const excludePaths = new Set(tasks.map((t) => t.worktreePath));
    return scanClaudeSessions(excludePaths);
  });

  ipcMain.handle(IPC.RESUME_CLAUDE_SESSION, async (_event, externalSessionId: string, cwd: string) => {
    if (!fs.existsSync(cwd)) {
      throw new Error(`Directory no longer exists: ${cwd}`);
    }

    const taskId = randomUUID();
    const name = path.basename(cwd);

    // Try to match cwd to a managed repo
    const config = loadConfig();
    const matchedRepo = config.repos.find((r: Repo) => cwd === r.path || cwd.startsWith(`${r.path}/`));
    let branch = '';
    if (matchedRepo) {
      try {
        const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        branch = stdout.trim();
      } catch {
        // ignore
      }
    }

    createSession(taskId, cwd, mainWindow, {
      resumeSessionId: externalSessionId,
      taskId,
      apiPort: getApiPort() ?? undefined,
      permissionMode: config.permissionMode,
      agentTeams: config.agentTeams,
    });

    const task: Task = {
      id: taskId,
      name,
      repoId: matchedRepo?.id ?? '',
      branch,
      worktreePath: cwd,
      sessionId,
      status: 'running',
      hasUnread: false,
      createdAt: Date.now(),
      isExternal: !matchedRepo,
    };

    tasks.push(task);
    saveTasks(tasks);

    startWatching(taskId, cwd, mainWindow, claudeCallbacks, sessionId);

    return task;
  });

  // Review
  ipcMain.handle(IPC.RUN_REVIEW, async (_event, taskId: string, scope?: 'working' | 'all', instructions?: string) => {
    const task = getTask(taskId);
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    const { reviewId, markdown } = await runReview(
      task.worktreePath,
      taskId,
      mainWindow,
      scope,
      instructions,
      baseBranch,
    );
    const sessionId = getReviewSessionId(taskId, reviewId);
    return { reviewId, markdown, sessionId };
  });

  ipcMain.handle(IPC.CANCEL_REVIEW, (_event, taskId: string) => {
    cancelReview(taskId);
  });

  ipcMain.handle(IPC.SAVE_REVIEW, (_event, taskId: string, reviewId: string, content: string) => {
    saveReview(taskId, reviewId, content);
  });

  ipcMain.handle(IPC.LOAD_REVIEW, (_event, taskId: string, reviewId: string) => {
    const content = loadReview(taskId, reviewId);
    if (content) {
      watchReviewFile(taskId, reviewId, mainWindow);
    }
    return content;
  });

  ipcMain.handle(IPC.RESUME_REVIEW, (_event, taskId: string, reviewId: string) => {
    const task = getTask(taskId);
    const sessionId = getReviewSessionId(taskId, reviewId);
    if (!sessionId) throw new Error('No review session to resume');

    // Kill existing review session if any
    const existing = reviewSessions.get(taskId);
    if (existing) killSession(existing);

    const reviewPtySessionId = `${taskId}-review`;
    const config = loadConfig();
    createSession(reviewPtySessionId, task.worktreePath, mainWindow, {
      resumeSessionId: sessionId,
      taskId,
      apiPort: getApiPort() ?? undefined,
      permissionMode: config.permissionMode,
      context: 'review',
    });
    reviewSessions.set(taskId, reviewPtySessionId);
    return reviewPtySessionId;
  });

  ipcMain.handle(IPC.LIST_REVIEWS, (_event, taskId: string) => {
    return listReviews(taskId);
  });

  ipcMain.handle(IPC.DELETE_REVIEW, (_event, taskId: string, reviewId: string) => {
    deleteReview(taskId, reviewId);
  });

  ipcMain.handle(IPC.CLOSE_REVIEW_SESSION, (_event, taskId: string) => {
    const reviewPtyId = reviewSessions.get(taskId);
    if (reviewPtyId) {
      killSession(reviewPtyId);
      reviewSessions.delete(taskId);
    }
  });

  // Integration
  ipcMain.handle(IPC.CHECK_INTEGRATION, () => checkIntegration());
  ipcMain.handle(IPC.INSTALL_INTEGRATION, () => installIntegration());

  ipcMain.handle(IPC.SET_ACTIVE_TASK_ID, (_event, taskId: string | null) => {
    setActiveTaskId(taskId);
    if (taskId && pendingRestore.has(taskId)) {
      try {
        restoreTaskSession(taskId, mainWindow);
      } catch (err) {
        console.error(`[ipc] Failed to restore task ${taskId}:`, err);
        updateTask(taskId, { status: 'error' });
      }
    }
  });

  ipcMain.handle(IPC.GET_LAST_ASSISTANT_MESSAGE, (_event, taskId: string) => {
    const task = getTask(taskId);
    const entries = getRecentClaudeEntries(taskId, task.worktreePath);
    const isAgentOutput = (e: ActivityEntry) =>
      e.claudeEventKind === 'assistant_text' ||
      (e.claudeEventKind === 'tool_use' && e.claudeToolName === 'AskUserQuestion');
    const last = [...entries].reverse().find(isAgentOutput);
    return last?.claudeText ?? null;
  });

  // Dialog
  ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Repository Directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Clipboard
  ipcMain.handle(IPC.READ_CLIPBOARD, () => {
    return clipboard.readText();
  });

  // gh CLI availability
  ipcMain.handle(IPC.CHECK_GH_AVAILABLE, async () => {
    try {
      await execFile('gh', ['--version'], { timeout: 5000, killSignal: 'SIGKILL' });
      return true;
    } catch {
      return false;
    }
  });

  // PR info fetch
  ipcMain.handle(IPC.FETCH_PR_INFO, async (_event, repoId: string, prNumber: number, ghRepo?: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);

    // Try gh CLI first
    try {
      const ghArgs = [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'headRefName,headRepositoryOwner,headRepository,title,number',
      ];
      if (ghRepo) ghArgs.push('--repo', ghRepo);
      const { stdout } = await execFile('gh', ghArgs, { cwd: repo.path, timeout: 10000, killSignal: 'SIGKILL' });
      const data = JSON.parse(stdout);
      const headRepoOwner = data.headRepositoryOwner?.login ?? '';
      const headRepoName = data.headRepository?.name ?? '';
      const repoOwner = (ghRepo ?? repo.githubPath)?.split('/')[0] ?? '';
      return {
        number: data.number,
        title: data.title,
        headBranch: data.headRefName,
        headRepoOwner,
        headRepoName,
        isFork: headRepoOwner !== '' && headRepoOwner !== repoOwner,
      };
    } catch {
      // gh not available or failed — fall back to git
    }

    // Fallback: git ls-remote
    const lsRemoteTarget = ghRepo ? `https://github.com/${ghRepo}.git` : 'origin';
    const { stdout: prRef } = await execFile('git', ['ls-remote', lsRemoteTarget, `refs/pull/${prNumber}/head`], {
      cwd: repo.path,
      timeout: 10000,
      killSignal: 'SIGKILL',
    });
    const prSha = prRef.split('\t')[0];
    if (!prSha) throw new Error(`PR #${prNumber} not found`);

    // Try to find the branch name by matching SHA against remote refs
    let headBranch = `pull/${prNumber}/head`;
    try {
      const { stdout: refs } = await execFile('git', ['ls-remote', '--heads', lsRemoteTarget], {
        cwd: repo.path,
        timeout: 10000,
        killSignal: 'SIGKILL',
      });
      for (const line of refs.split('\n')) {
        const [sha, ref] = line.split('\t');
        if (sha === prSha && ref) {
          headBranch = ref.replace('refs/heads/', '');
          break;
        }
      }
    } catch {
      // ignore, use fallback branch name
    }

    return {
      number: prNumber,
      headBranch,
      headRepoOwner: '',
      headRepoName: '',
      isFork: false,
    };
  });

  // Match repo for PR (checks all remotes across configured repos)
  ipcMain.handle(IPC.MATCH_REPO_FOR_PR, async (_event, owner: string, repoName: string) => {
    const config = loadConfig();
    const target = `${owner}/${repoName}`.toLowerCase();
    for (const repo of config.repos) {
      const remotes = await getRemotes(repo.path);
      if (remotes.some((r) => r.githubPath.toLowerCase() === target)) {
        return repo.id;
      }
    }
    return null;
  });

  // Notes
  ipcMain.handle(IPC.NOTE_LIST, (_event, repoId: string) => {
    return listNotes(repoId);
  });

  ipcMain.handle(IPC.NOTE_CREATE, (_event, repoId: string, text: string) => {
    return createNote(repoId, text);
  });

  ipcMain.handle(
    IPC.NOTE_UPDATE,
    (_event, repoId: string, noteId: string, updates: { text?: string; addressed?: boolean }) => {
      return updateNote(repoId, noteId, updates);
    },
  );

  ipcMain.handle(IPC.NOTE_DELETE, (_event, repoId: string, noteId: string) => {
    deleteNote(repoId, noteId);
  });

  // Permission
  ipcMain.handle(IPC.RESOLVE_PERMISSION, (_event, requestId: string, decision: PermissionDecision) => {
    resolveRequest(requestId, decision);
  });

  // Stats
  ipcMain.handle(IPC.GET_STATS, (_event, since?: number) =>
    getStats((data) => {
      mainWindow.webContents.send(IPC_STREAM.STATS_UPDATE, data);
    }, since),
  );

  // Supervisor
  const supervisorTaskCreator = async (item: import('../shared/types').SupervisorItem): Promise<Task> => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === item.repoId);
    if (!repo) throw new Error(`Repo not found: ${item.repoId}`);
    if (!item.worktreePath) throw new Error('Supervisor item has no worktree');

    const taskId = randomUUID();

    createSession(taskId, item.worktreePath, mainWindow, {
      taskId,
      apiPort: getApiPort() ?? undefined,
      permissionMode: config.permissionMode,
      agentTeams: config.agentTeams,
    });

    const task: Task = {
      id: taskId,
      name: item.name,
      repoId: item.repoId,
      branch: item.branch,
      worktreePath: item.worktreePath,
      sessionId,
      status: 'running',
      hasUnread: false,
      createdAt: Date.now(),
    };

    tasks.push(task);
    saveTasks(tasks);
    startWatching(taskId, item.worktreePath, mainWindow, claudeCallbacks, sessionId);
    return task;
  };

  initSupervisor(mainWindow, supervisorTaskCreator);

  ipcMain.handle(IPC.SUPERVISOR_GET_STATE, () => getSupervisorState());
  ipcMain.handle(IPC.SUPERVISOR_START, () => startSupervisor());
  ipcMain.handle(IPC.SUPERVISOR_STOP, () => stopSupervisor());
  ipcMain.handle(IPC.SUPERVISOR_SET_CONCURRENCY, (_event, n: number) => setSupervisorConcurrency(n));
  ipcMain.handle(IPC.SUPERVISOR_PAUSE_ITEM, (_event, itemId: string) => pauseItem(itemId));
  ipcMain.handle(IPC.SUPERVISOR_RESUME_ITEM, (_event, itemId: string) => resumeItem(itemId));
  ipcMain.handle(IPC.SUPERVISOR_OPEN_ITEM, (_event, itemId: string) => openItem(itemId));
  ipcMain.handle(IPC.SUPERVISOR_REMOVE_ITEM, (_event, itemId: string) => removeItem(itemId));

  // Slack
  ipcMain.handle(IPC.SLACK_START_OAUTH, () => startOAuth(mainWindow));
  ipcMain.handle(IPC.SLACK_DISCONNECT, () => disconnectSlack());
}
