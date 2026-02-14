import { ipcMain, BrowserWindow, clipboard, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc-channels';
import type { Task, Repo, CreateTaskParams, AddRepoParams, BifrostConfig, CaptureContextParams } from '../shared/types';
import { loadConfig, saveConfig } from './config';
import { addRepo, removeRepo, getRepoBranches } from './repo-manager';
import { createWorktree, removeWorktree } from './worktree-manager';
import { createSession, createShellSession, writeToSession, resizeSession, killSession } from './session-manager';
import { getDiff } from './diff-service';
import { getGitLog } from './git-log-service';
import { openInIde } from './ide-launcher';
import { loadTasks, saveTasks } from './task-store';
import { startWatching, stopWatching, getActivityLog, clearActivityLog, getLastChangedFile } from './activity-watcher';
import { getApiPort } from './bifrost-api';
import { store as storeContext, loadPersistedContexts, getClaudeJsonlPath, findTranscriptMatch } from './context-store';
import { scanClaudeSessions } from './claude-session-scanner';

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

async function destroyTask(taskId: string): Promise<void> {
  const task = getTask(taskId);
  stopWatching(taskId);
  if (task.status === 'running') {
    killSession(task.sessionId);
  }
  if (fs.existsSync(task.worktreePath)) {
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
      createSession(sessionId, task.worktreePath, mainWindow, {
        resume: true, taskId: task.id, apiPort: getApiPort() ?? undefined, sandbox: loadConfig().sandbox,
      });
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx !== -1) {
        tasks[idx] = { ...tasks[idx], sessionId, status: 'running', hasUnread: false };
      }
    }
  }

  saveTasks(tasks);

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

  // Tasks
  ipcMain.handle(IPC.CREATE_TASK, async (_event, params: CreateTaskParams) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === params.repoId);
    if (!repo) throw new Error(`Repo not found: ${params.repoId}`);

    const worktreePath = await createWorktree(repo.path, params.name, params.branch);
    const sessionId = randomUUID();
    const taskId = randomUUID();

    createSession(sessionId, worktreePath, mainWindow, {
      taskId, apiPort: getApiPort() ?? undefined, sandbox: config.sandbox,
    });

    const task: Task = {
      id: taskId,
      name: params.name,
      repoId: params.repoId,
      branch: params.branch,
      worktreePath,
      sessionId,
      status: 'running',
      hasUnread: false,
      createdAt: Date.now(),
    };

    tasks.push(task);
    saveTasks(tasks);

    // Start watching for file changes
    startWatching(task.id, worktreePath, mainWindow);

    return task;
  });

  ipcMain.handle(IPC.CLOSE_TASK, async (_event, taskId: string) => {
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.STOP_TASK, (_event, taskId: string) => {
    const task = getTask(taskId);
    if (task.status === 'running') {
      killSession(task.sessionId);
    }
    return updateTask(taskId, { status: 'stopped' });
  });

  ipcMain.handle(IPC.ARCHIVE_TASK, (_event, taskId: string) => {
    const task = getTask(taskId);

    stopWatching(taskId);

    // Kill session if still running
    if (task.status === 'running') {
      killSession(task.sessionId);
    }

    return updateTask(taskId, {
      status: 'archived',
      archivedAt: Date.now(),
    });
  });

  ipcMain.handle(IPC.REOPEN_TASK, (_event, taskId: string) => {
    const task = getTask(taskId);

    // Check working directory still exists
    if (!fs.existsSync(task.worktreePath)) {
      throw new Error(`Directory no longer exists: ${task.worktreePath}`);
    }

    const sessionId = randomUUID();
    createSession(sessionId, task.worktreePath, mainWindow, {
      claudeSessionId: task.claudeSessionId,
      taskId,
      apiPort: getApiPort() ?? undefined,
      sandbox: loadConfig().sandbox,
    });

    // Restart file watcher
    startWatching(taskId, task.worktreePath, mainWindow);

    return updateTask(taskId, {
      sessionId,
      status: 'running',
      hasUnread: false,
      archivedAt: undefined,
    });
  });

  ipcMain.handle(IPC.RENAME_TASK, (_event, taskId: string, name: string) => {
    return updateTask(taskId, { name });
  });

  ipcMain.handle(IPC.DELETE_TASK, async (_event, taskId: string) => {
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.LIST_TASKS, () => {
    return tasks;
  });

  // Dev terminal
  const devSessions = new Map<string, string>(); // taskId -> dev sessionId

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

  // Diff
  ipcMain.handle(IPC.GET_DIFF, async (_event, taskId: string) => {
    const task = getTask(taskId);
    return getDiff(task.worktreePath);
  });

  // Git log
  ipcMain.handle(IPC.GET_GIT_LOG, async (_event, taskId: string) => {
    const task = getTask(taskId);
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === task.repoId);
    return getGitLog(task.worktreePath, repo?.defaultBranch);
  });

  // Shell
  ipcMain.handle(IPC.OPEN_URL, (_event, url: string) => shell.openExternal(url));

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
        startWatching(task.id, task.worktreePath, mainWindow);
      }
    }
  }

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

  ipcMain.handle(IPC.RESUME_CLAUDE_SESSION, (_event, claudeSessionId: string, cwd: string) => {
    if (!fs.existsSync(cwd)) {
      throw new Error(`Directory no longer exists: ${cwd}`);
    }

    const sessionId = randomUUID();
    const taskId = randomUUID();
    const name = path.basename(cwd);

    createSession(sessionId, cwd, mainWindow, {
      claudeSessionId,
      taskId,
      apiPort: getApiPort() ?? undefined,
      sandbox: loadConfig().sandbox,
    });

    const task: Task = {
      id: taskId,
      name,
      repoId: '',
      branch: '',
      worktreePath: cwd,
      sessionId,
      status: 'running',
      hasUnread: false,
      createdAt: Date.now(),
      claudeSessionId,
      isExternal: true,
    };

    tasks.push(task);
    saveTasks(tasks);

    startWatching(taskId, cwd, mainWindow);

    return task;
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
}
