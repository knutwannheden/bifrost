import { ipcMain, BrowserWindow, dialog } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import fs from 'node:fs';
import { IPC } from '../shared/ipc-channels';
import type { Task, Repo, CreateTaskParams, AddRepoParams, BifrostConfig } from '../shared/types';
import { loadConfig, saveConfig } from './config';
import { addRepo, removeRepo, getRepoBranches } from './repo-manager';
import { createWorktree, removeWorktree } from './worktree-manager';
import { createSession, writeToSession, resizeSession, killSession } from './session-manager';
import { getDiff } from './diff-service';
import { openInIde } from './ide-launcher';
import { loadTasks, saveTasks } from './task-store';
import { startWatching, stopWatching, getActivityLog, clearActivityLog } from './activity-watcher';
import { findLatestClaudeSessionId } from './claude-watcher';

// In-memory task list, synced to disk
let tasks: Task[] = [];

function getTask(taskId: string): Task {
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

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Load persisted tasks on startup, restore sessions for previously-running tasks
  const persisted = loadTasks();
  const tasksToRestore = persisted.filter((t) => t.status === 'running');

  tasks = persisted.map((t) =>
    t.status === 'running' ? { ...t, status: 'stopped' as const } : t,
  );

  // Re-spawn sessions for tasks that were running when the app quit
  for (const task of tasksToRestore) {
    if (fs.existsSync(task.worktreePath)) {
      const sessionId = uuidv4();
      createSession(sessionId, task.worktreePath, mainWindow, { resume: true });
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
    saveConfig(updated as BifrostConfig);
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
    const sessionId = uuidv4();

    createSession(sessionId, worktreePath, mainWindow);

    const task: Task = {
      id: uuidv4(),
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
    const task = getTask(taskId);

    stopWatching(taskId);
    killSession(task.sessionId);

    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === task.repoId);
    if (repo) {
      try {
        await removeWorktree(repo.path, task.worktreePath);
      } catch {
        // Worktree may already be removed
      }
    }

    tasks = tasks.filter((t) => t.id !== taskId);
    saveTasks(tasks);
  });

  ipcMain.handle(IPC.STOP_TASK, (_event, taskId: string) => {
    const task = getTask(taskId);

    if (task.status === 'running') {
      killSession(task.sessionId);
    }

    return updateTask(taskId, {
      status: 'stopped',
    });
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

    // Check worktree still exists
    if (!fs.existsSync(task.worktreePath)) {
      throw new Error(`Worktree no longer exists: ${task.worktreePath}`);
    }

    // Find the most recent Claude session to resume
    const claudeSessionId = findLatestClaudeSessionId(task.worktreePath);

    const sessionId = uuidv4();
    createSession(sessionId, task.worktreePath, mainWindow, { claudeSessionId: claudeSessionId ?? undefined });

    // Restart file watcher
    startWatching(taskId, task.worktreePath, mainWindow);

    return updateTask(taskId, {
      sessionId,
      status: 'running',
      hasUnread: false,
      archivedAt: undefined,
      claudeSessionId: claudeSessionId ?? undefined,
    });
  });

  ipcMain.handle(IPC.RENAME_TASK, (_event, taskId: string, name: string) => {
    return updateTask(taskId, { name });
  });

  ipcMain.handle(IPC.DELETE_TASK, async (_event, taskId: string) => {
    const task = getTask(taskId);

    stopWatching(taskId);

    // Kill session if running
    if (task.status === 'running') {
      killSession(task.sessionId);
    }

    // Remove worktree if it exists
    if (fs.existsSync(task.worktreePath)) {
      const config = loadConfig();
      const repo = config.repos.find((r: Repo) => r.id === task.repoId);
      if (repo) {
        try {
          await removeWorktree(repo.path, task.worktreePath);
        } catch {
          // Best effort
        }
      }
    }

    tasks = tasks.filter((t) => t.id !== taskId);
    saveTasks(tasks);
  });

  ipcMain.handle(IPC.LIST_TASKS, () => {
    return tasks;
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

  // IDE
  ipcMain.handle(IPC.OPEN_IN_IDE, (_event, worktreePath: string) => {
    return openInIde(worktreePath);
  });

  // Activity Log
  ipcMain.handle(IPC.GET_ACTIVITY_LOG, (_event, taskId: string) => {
    return getActivityLog(taskId);
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
    // Update the BrowserWindow title
    const task = getTask(taskId);
    // Only update window title for the "current" task — the renderer knows which is active
    mainWindow.setTitle(`BIFROST — ${title}`);
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
