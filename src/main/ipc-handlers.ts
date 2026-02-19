import { ipcMain, BrowserWindow, clipboard, dialog, shell } from 'electron';
import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
import { IPC, IPC_STREAM } from '../shared/ipc-channels';
import type { Task, Repo, CreateTaskParams, AddRepoParams, BifrostConfig, CaptureContextParams, ActivityEntry, PermissionDecision } from '../shared/types';
import { loadConfig, saveConfig } from './config';
import { addRepo, removeRepo, getRepoBranches, detectBaseBranch, getRemotes } from './repo-manager';
import { createWorktree, createWorktreeFromPr, restoreWorktree, removeWorktree } from './worktree-manager';
import { createSession, createShellSession, writeToSession, resizeSession, killSession, drainSessionBuffer } from './session-manager';
import { getDiff, getDiffStats, getFileStatuses } from './diff-service';
import { getGitLog } from './git-log-service';
import { openInIde } from './ide-launcher';
import { loadTasks, saveTasks } from './task-store';
import { startWatching, stopWatching, getActivityLog, clearActivityLog, getLastChangedFile } from './activity-watcher';
import { getApiPort } from './bifrost-api';
import { store as storeContext, loadPersistedContexts, getClaudeJsonlPath, findTranscriptMatch } from './context-store';
import { scanClaudeSessions } from './claude-session-scanner';
import { summarizeTask, countJsonlLines } from './task-summarizer';
import { runReview, saveReview, loadReview, watchReviewFile } from './review-service';
import { checkIntegration, installIntegration } from './integration-installer';
import { getRecentClaudeEntries } from './claude-watcher';
import { scanRecentRepos } from './history-scanner';
import { resolveRequest, cancelTaskRequests, setWorktreePathResolver } from './permission-manager';
import { setActiveTaskId } from './notification-service';

// In-memory task list, synced to disk
let tasks: Task[] = [];

export function getTasks(): Task[] {
  return tasks;
}

export function getTask(taskId: string): Task {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function updateTask(taskId: string, updates: Partial<Task>): Task {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) throw new Error(`Task not found: ${taskId}`);
  tasks[idx] = { ...tasks[idx], ...updates };
  saveTasks(tasks);
  return tasks[idx];
}

/**
 * Resolve the effective base branch for diff/review comparison.
 * Uses repo.defaultBranch if available and different from the current branch,
 * otherwise auto-detects from origin/HEAD or main/master.
 */
async function resolveBaseBranch(task: Task): Promise<string | undefined> {
  const config = loadConfig();
  const repo = config.repos.find((r: Repo) => r.id === task.repoId);
  let base = repo?.defaultBranch;

  // Check if the stored base branch is the same as the current branch (useless for diff)
  if (base) {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: task.worktreePath,
      });
      if (stdout.trim() === base) base = undefined;
    } catch {
      // ignore
    }
  }

  if (!base) {
    base = await detectBaseBranch(task.worktreePath);
  }

  return base;
}

async function destroyTask(taskId: string): Promise<void> {
  cancelTaskRequests(taskId);
  const task = getTask(taskId);
  stopWatching(taskId);
  if (task.status === 'running') {
    killSession(task.sessionId);
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

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Load persisted context entries from disk
  loadPersistedContexts();

  // Load persisted tasks on startup, restore sessions for previously-running tasks
  const persisted = loadTasks();
  const tasksToRestore = persisted.filter((t) => t.status === 'running');

  tasks = persisted.map((t) =>
    t.status === 'running' ? { ...t, status: 'stopped' as const } : t,
  );

  // Re-spawn sessions for tasks that were running when the app quit
  for (const task of tasksToRestore) {
    if (fs.existsSync(task.worktreePath)) {
      const sessionId = randomUUID();
      const startupConfig = loadConfig();
      createSession(sessionId, task.worktreePath, mainWindow, {
        resume: true, taskId: task.id, apiPort: getApiPort() ?? undefined, permissionMode: startupConfig.permissionMode, agentTeams: startupConfig.agentTeams,
      });

      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], sessionId, status: 'running', hasUnread: false };
      }
    }
  }

  saveTasks(tasks);

  // Permission manager: provide worktree path resolver
  setWorktreePathResolver((taskId) => getTask(taskId).worktreePath);

  // Claude watcher callbacks
  const claudeCallbacks = {
    onSummary: (taskId: string, summary: string) => {
      try {
        updateTask(taskId, { summary });
        mainWindow.webContents.send(IPC_STREAM.TASK_SUMMARY, taskId, summary);
      } catch { /* task may have been deleted */ }
    },
    onSessionChange: (taskId: string, claudeSessionId: string) => {
      try {
        updateTask(taskId, { claudeSessionId });
      } catch { /* task may have been deleted */ }
    },
  };

  // Config
  ipcMain.handle(IPC.LOAD_CONFIG, () => loadConfig());
  ipcMain.handle(IPC.SAVE_CONFIG, (_event, config: BifrostConfig) => saveConfig(config));
  ipcMain.handle(IPC.SET_IDE, (_event, ide: 'code' | 'idea') => {
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
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.path });
    return stdout.trim();
  });

  ipcMain.handle(IPC.GET_RECENT_REPOS, () => {
    const config = loadConfig();
    const excludePaths = new Set(config.repos.map((r: Repo) => r.path));
    return scanRecentRepos(excludePaths);
  });

  // Dev terminal sessions (taskId -> dev sessionId)
  const devSessions = new Map<string, string>();

  // Tasks
  ipcMain.handle(IPC.CREATE_TASK, async (_event, params: CreateTaskParams) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === params.repoId);
    if (!repo) throw new Error(`Repo not found: ${params.repoId}`);

    let worktreePath: string;
    let branch = params.branch;
    let inPlace = false;

    if (params.inPlace) {
      // Conflict check: only one non-archived in-place task per repo
      const conflict = tasks.find(
        (t) => t.status !== 'archived' && t.worktreePath === repo.path,
      );
      if (conflict) {
        throw new Error(`An active task "${conflict.name}" already uses the main worktree for this repo`);
      }
      worktreePath = repo.path;
      // Auto-detect current branch
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo.path });
      branch = stdout.trim();
      inPlace = true;
    } else {
      worktreePath = params.prInfo
        ? await createWorktreeFromPr(repo.path, params.name, params.prInfo, config.localWorktrees)
        : await createWorktree(repo.path, params.name, params.branch, config.localWorktrees);
    }

    const sessionId = randomUUID();
    const taskId = randomUUID();

    createSession(sessionId, worktreePath, mainWindow, {
      taskId, apiPort: getApiPort() ?? undefined, permissionMode: config.permissionMode, agentTeams: config.agentTeams,
    });


    const task: Task = {
      id: taskId,
      name: params.name,
      repoId: params.repoId,
      branch,
      worktreePath,
      sessionId,
      status: 'running',
      hasUnread: false,
      createdAt: Date.now(),
      ...(inPlace && { inPlace: true }),
    };

    tasks.push(task);
    saveTasks(tasks);

    // Start watching for file changes
    startWatching(task.id, worktreePath, mainWindow, claudeCallbacks);

    return task;
  });

  ipcMain.handle(IPC.CLOSE_TASK, async (_event, taskId: string) => {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.STOP_TASK, (_event, taskId: string) => {
    const task = getTask(taskId);
    if (task.status === 'running') {
      cancelTaskRequests(taskId);
      killSession(task.sessionId);
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

    // Kill session if still running
    if (task.status === 'running') {
      killSession(task.sessionId);
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
      worktreePath = await restoreWorktree(repo.path, task.name, config.localWorktrees);
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

    const sessionId = randomUUID();
    const reopenConfig = loadConfig();
    createSession(sessionId, worktreePath, mainWindow, {
      resume: true,
      claudeSessionId: task.claudeSessionId,
      taskId,
      apiPort: getApiPort() ?? undefined,
      permissionMode: reopenConfig.permissionMode,
      agentTeams: reopenConfig.agentTeams,
    });


    // Restart file watcher
    startWatching(taskId, worktreePath, mainWindow, claudeCallbacks);

    return updateTask(taskId, {
      sessionId,
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
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.LIST_TASKS, () => {
    return tasks;
  });

  ipcMain.handle(IPC.REORDER_TASKS, (_event, taskIds: string[]) => {
    const idSet = new Set(taskIds);
    const reordered = taskIds.map((id) => tasks.find((t) => t.id === id)!).filter(Boolean);
    let ri = 0;
    tasks = tasks.map((t) => idSet.has(t.id) ? reordered[ri++] : t);
    saveTasks(tasks);
  });

  ipcMain.handle(IPC.CREATE_DEV_TERMINAL, (_event, taskId: string) => {
    const task = getTask(taskId);
    // Kill existing dev session if any
    const existing = devSessions.get(taskId);
    if (existing) killSession(existing);

    const devSessionId = randomUUID();
    createShellSession(devSessionId, task.worktreePath, mainWindow);
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
    const baseBranch = await resolveBaseBranch(task);
    return getDiff(task.worktreePath, baseBranch, scope);
  });

  // File statuses (staged/unstaged/committed/untracked)
  ipcMain.handle(IPC.GET_FILE_STATUSES, async (_event, taskId: string) => {
    const task = getTask(taskId);
    const baseBranch = await resolveBaseBranch(task);
    return getFileStatuses(task.worktreePath, baseBranch);
  });

  // Diff stats
  ipcMain.handle(IPC.GET_DIFF_STATS, async (_event, taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    const baseBranch = await resolveBaseBranch(task);
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
      });
      const url = stdout.trim();
      return url || null;
    } catch {
      return null;
    }
  });

  // Shell
  ipcMain.handle(IPC.OPEN_URL, (_event, url: string) => {
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

  // Start watchers for any running tasks on startup
  for (const task of tasks) {
    if (task.status === 'running' || task.status === 'stopped') {
      if (fs.existsSync(task.worktreePath)) {
        startWatching(task.id, task.worktreePath, mainWindow, claudeCallbacks);
      }
    }
  }

  // Summarize unsummarized tasks on startup
  (async () => {
    for (const task of tasks) {
      if (!task.summary && countJsonlLines(task.worktreePath) >= 3) {
        const summary = await summarizeTask(task.worktreePath);
        if (summary) claudeCallbacks.onSummary(task.id, summary);
      }
    }
  })();

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

  ipcMain.handle(IPC.RESUME_CLAUDE_SESSION, async (_event, claudeSessionId: string, cwd: string) => {
    if (!fs.existsSync(cwd)) {
      throw new Error(`Directory no longer exists: ${cwd}`);
    }

    const sessionId = randomUUID();
    const taskId = randomUUID();
    const name = path.basename(cwd);

    // Try to match cwd to a managed repo
    const config = loadConfig();
    const matchedRepo = config.repos.find((r: Repo) => cwd === r.path || cwd.startsWith(r.path + '/'));
    let branch = '';
    if (matchedRepo) {
      try {
        const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        branch = stdout.trim();
      } catch {
        // ignore
      }
    }

    createSession(sessionId, cwd, mainWindow, {
      claudeSessionId,
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
      claudeSessionId,
      isExternal: !matchedRepo,
    };

    tasks.push(task);
    saveTasks(tasks);

    startWatching(taskId, cwd, mainWindow, claudeCallbacks);

    return task;
  });

  // Review
  ipcMain.handle(IPC.RUN_REVIEW, async (_event, taskId: string) => {
    const task = getTask(taskId);
    const baseBranch = await resolveBaseBranch(task);
    const result = await runReview(task.worktreePath, taskId, mainWindow, baseBranch);
    watchReviewFile(taskId, mainWindow);
    return result;
  });

  ipcMain.handle(IPC.SAVE_REVIEW, (_event, taskId: string, content: string) => {
    saveReview(taskId, content);
  });

  ipcMain.handle(IPC.LOAD_REVIEW, (_event, taskId: string) => {
    const content = loadReview(taskId);
    if (content) {
      watchReviewFile(taskId, mainWindow);
    }
    return content;
  });

  // Integration
  ipcMain.handle(IPC.CHECK_INTEGRATION, () => checkIntegration());
  ipcMain.handle(IPC.INSTALL_INTEGRATION, () => installIntegration());

  ipcMain.handle(IPC.SET_ACTIVE_TASK_ID, (_event, taskId: string | null) => {
    setActiveTaskId(taskId);
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
      await execFile('gh', ['--version'], { timeout: 5000 });
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
      const ghArgs = ['pr', 'view', String(prNumber), '--json', 'headRefName,headRepositoryOwner,headRepository,title,number'];
      if (ghRepo) ghArgs.push('--repo', ghRepo);
      const { stdout } = await execFile(
        'gh',
        ghArgs,
        { cwd: repo.path, timeout: 10000 },
      );
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
    const { stdout: prRef } = await execFile(
      'git',
      ['ls-remote', lsRemoteTarget, `refs/pull/${prNumber}/head`],
      { cwd: repo.path, timeout: 10000 },
    );
    const prSha = prRef.split('\t')[0];
    if (!prSha) throw new Error(`PR #${prNumber} not found`);

    // Try to find the branch name by matching SHA against remote refs
    let headBranch = `pull/${prNumber}/head`;
    try {
      const { stdout: refs } = await execFile(
        'git',
        ['ls-remote', '--heads', lsRemoteTarget],
        { cwd: repo.path, timeout: 10000 },
      );
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

  // Permission
  ipcMain.handle(IPC.RESOLVE_PERMISSION, (_event, requestId: string, decision: PermissionDecision) => {
    resolveRequest(requestId, decision);
  });
}
