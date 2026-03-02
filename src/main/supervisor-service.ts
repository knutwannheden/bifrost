import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BrowserWindow } from 'electron';

import { IPC_STREAM } from '../shared/ipc-channels';
import type { SupervisorItem, SupervisorState, Task } from '../shared/types';
import { loadSupervisorState, saveSupervisorState } from './supervisor-store';
import { generateTaskName } from '../shared/name-generator';
import { listNotes } from './note-store';
import { loadConfig } from './config';
import { createWorktree, removeWorktree } from './worktree-manager';

type TaskCreator = (item: SupervisorItem) => Promise<Task>;

let mainWindow: BrowserWindow | null = null;
let taskCreator: TaskCreator | null = null;
let state: SupervisorState = { running: false, concurrency: 2, items: [] };
const processes = new Map<string, ChildProcess>();

function broadcastState(): void {
  saveSupervisorState(state);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.SUPERVISOR_UPDATE, state);
  }
}

function updateItem(itemId: string, updates: Partial<SupervisorItem>): void {
  state = {
    ...state,
    items: state.items.map((item) =>
      item.id === itemId ? { ...item, ...updates } : item,
    ),
  };
}

export function initSupervisor(window: BrowserWindow, creator: TaskCreator): void {
  mainWindow = window;
  taskCreator = creator;
  state = loadSupervisorState();

  // Running items from a previous session → paused (process is gone)
  for (const item of state.items) {
    if (item.status === 'running') {
      item.status = 'paused';
    }
  }

  // If the supervisor was running, resume processing paused items
  if (state.running) {
    processQueue();
  }

  broadcastState();
}

export function getSupervisorState(): SupervisorState {
  return state;
}

export function startSupervisor(): SupervisorState {
  state.running = true;

  // Scan all repos' notes and queue items for untracked notes
  const config = loadConfig();
  const trackedNoteIds = new Set(state.items.map((item) => item.noteId));

  for (const repo of config.repos) {
    const notes = listNotes(repo.id);
    for (const note of notes) {
      if (!trackedNoteIds.has(note.id)) {
        const name = generateTaskName();
        state.items.push({
          id: randomUUID(),
          noteId: note.id,
          repoId: repo.id,
          noteText: note.text,
          status: 'queued',
          name,
          branch: name,
          createdAt: Date.now(),
        });
      }
    }
  }

  processQueue();
  broadcastState();
  return state;
}

export function stopSupervisor(): SupervisorState {
  state.running = false;

  // Kill all running processes
  for (const item of state.items) {
    if (item.status === 'running') {
      const proc = processes.get(item.id);
      if (proc) {
        proc.kill('SIGTERM');
        processes.delete(item.id);
      }
      updateItem(item.id, { status: 'paused' });
    }
  }

  broadcastState();
  return state;
}

export function setSupervisorConcurrency(n: number): SupervisorState {
  state.concurrency = Math.max(1, Math.min(n, 10));
  if (state.running) {
    processQueue();
  }
  broadcastState();
  return state;
}

export function pauseItem(itemId: string): SupervisorState {
  const item = state.items.find((i) => i.id === itemId);
  if (!item || item.status !== 'running') return state;

  const proc = processes.get(itemId);
  if (proc) {
    proc.kill('SIGTERM');
    processes.delete(itemId);
  }
  updateItem(itemId, { status: 'paused' });
  broadcastState();

  if (state.running) processQueue();
  return state;
}

export function resumeItem(itemId: string): SupervisorState {
  const item = state.items.find((i) => i.id === itemId);
  if (!item || item.status !== 'paused') return state;

  updateItem(itemId, { status: 'queued' });
  if (state.running) processQueue();
  broadcastState();
  return state;
}

export async function openItem(itemId: string): Promise<Task> {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) throw new Error(`Supervisor item not found: ${itemId}`);
  if (!taskCreator) throw new Error('Supervisor not initialized');

  // Kill if running
  if (item.status === 'running') {
    const proc = processes.get(itemId);
    if (proc) {
      proc.kill('SIGTERM');
      processes.delete(itemId);
    }
  }

  const task = await taskCreator(item);
  updateItem(itemId, { status: 'opened', openedAsTaskId: task.id });
  broadcastState();

  if (state.running) processQueue();
  return task;
}

export function removeItem(itemId: string): SupervisorState {
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return state;

  // Only allow removing non-running items
  if (item.status === 'running') {
    const proc = processes.get(itemId);
    if (proc) {
      proc.kill('SIGTERM');
      processes.delete(itemId);
    }
  }

  // Clean up worktree if it exists and wasn't opened as a task
  if (item.worktreePath && !item.openedAsTaskId) {
    const config = loadConfig();
    const repo = config.repos.find((r) => r.id === item.repoId);
    if (repo) {
      removeWorktree(repo.path, item.worktreePath).catch(() => {});
    }
  }

  state = { ...state, items: state.items.filter((i) => i.id !== itemId) };
  broadcastState();
  return state;
}


// --- Internal ---

function processQueue(): void {
  if (!state.running) return;

  const runningCount = state.items.filter((i) => i.status === 'running').length;
  const available = state.concurrency - runningCount;
  if (available <= 0) return;

  // Pick items: prefer paused, then queued
  const paused = state.items.filter((i) => i.status === 'paused');
  const queued = state.items.filter((i) => i.status === 'queued');
  const toStart = [...paused, ...queued].slice(0, available);

  for (const item of toStart) {
    updateItem(item.id, { status: 'running', startedAt: Date.now() });
    spawnProcess(item).catch((err) => {
      updateItem(item.id, {
        status: 'error',
        errorMessage: (err as Error).message,
        completedAt: Date.now(),
      });
      broadcastState();
      processQueue();
    });
  }

  broadcastState();
}

async function spawnProcess(item: SupervisorItem): Promise<void> {
  const config = loadConfig();
  const repo = config.repos.find((r) => r.id === item.repoId);
  if (!repo) throw new Error(`Repo not found: ${item.repoId}`);

  // Create worktree if needed
  let worktreePath = item.worktreePath;
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    worktreePath = await createWorktree(repo.path, item.name, repo.defaultBranch);
    updateItem(item.id, { worktreePath });
    broadcastState();
  }

  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  env.BIFROST_CONTEXT = 'supervisor';
  env.BIFROST_SUPERVISOR_ITEM_ID = item.id;
  const portFile = path.join(os.homedir(), '.bifrost', 'api-port');
  try { env.BIFROST_API_PORT = fs.readFileSync(portFile, 'utf-8').trim(); } catch { /* port file may not exist */ }

  const args: string[] = ['-p'];
  if (config.permissionMode === 'skip-permissions') {
    args.push('--dangerously-skip-permissions');
  }

  args.push(item.noteText);

  const proc = spawn('claude', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: worktreePath,
    env,
  });

  processes.set(item.id, proc);

  let stderr = '';

  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  proc.on('close', (code) => {
    processes.delete(item.id);

    // Item may have been paused/opened while running — check current status
    const current = state.items.find((i) => i.id === item.id);
    if (!current || current.status !== 'running') return;

    if (code === 0) {
      updateItem(item.id, { status: 'done', completedAt: Date.now() });
    } else {
      updateItem(item.id, {
        status: 'error',
        errorMessage: stderr.trim().slice(0, 500) || `claude exited with code ${code}`,
        completedAt: Date.now(),
      });
    }
    broadcastState();
    processQueue();
  });

  proc.on('error', (err) => {
    processes.delete(item.id);

    const current = state.items.find((i) => i.id === item.id);
    if (!current || current.status !== 'running') return;

    updateItem(item.id, {
      status: 'error',
      errorMessage: err.message,
      completedAt: Date.now(),
    });
    broadcastState();
    processQueue();
  });
}
