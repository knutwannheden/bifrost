import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';

import { IPC_STREAM } from '../shared/ipc-channels';
import { generateTaskName } from '../shared/name-generator';
import type { SupervisorItem, SupervisorState, Task } from '../shared/types';
import { loadConfig } from './config';
import { listNotes, updateNote } from './note-store';
import { killSession, spawnSession } from './session-manager';
import { loadSupervisorState, saveSupervisorState } from './supervisor-store';
import { createWorktree, removeWorktree } from './worktree-manager';

type TaskCreator = (item: SupervisorItem) => Promise<Task>;

let mainWindow: BrowserWindow | null = null;
let taskCreator: TaskCreator | null = null;
let state: SupervisorState = { running: false, concurrency: 2, items: [] };
// itemId → PTY session ID of its running Claude session
const sessionIds = new Map<string, string>();
// itemIds whose Claude session signaled completion via the Stop hook
const completedItems = new Set<string>();

function broadcastState(): void {
  saveSupervisorState(state);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.SUPERVISOR_UPDATE, state);
  }
}

function updateItem(itemId: string, updates: Partial<SupervisorItem>): void {
  state = {
    ...state,
    items: state.items.map((item) => (item.id === itemId ? { ...item, ...updates } : item)),
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

  // Scan all repos' notes and queue items for unprocessed notes
  const config = loadConfig();
  const itemByNoteId = new Map(state.items.map((item) => [item.noteId, item]));

  for (const repo of config.repos) {
    const notes = listNotes(repo.id);
    for (const note of notes) {
      if (note.addressed) continue;

      const existing = itemByNoteId.get(note.id);
      if (existing && (existing.status === 'done' || existing.status === 'opened')) {
        // Note was un-addressed after completion — remove old item and re-queue
        state = { ...state, items: state.items.filter((i) => i.id !== existing.id) };
      } else if (existing) {
        // Already queued/running/paused — leave as-is
        continue;
      }

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

  processQueue();
  broadcastState();
  return state;
}

export function stopSupervisor(): SupervisorState {
  state.running = false;

  // Kill all running sessions
  for (const item of state.items) {
    if (item.status === 'running') {
      updateItem(item.id, { status: 'paused' });
      killItemSession(item.id);
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

  updateItem(itemId, { status: 'paused' });
  killItemSession(itemId);
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
    updateItem(itemId, { status: 'opened' });
    killItemSession(itemId);
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

  // Kill the session if the item is still running
  if (item.status === 'running') {
    killItemSession(itemId);
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

function killItemSession(itemId: string): void {
  const ptySessionId = sessionIds.get(itemId);
  if (ptySessionId) {
    killSession(ptySessionId);
    sessionIds.delete(itemId);
  }
  completedItems.delete(itemId);
}

/**
 * Called when an item's Claude session signals completion via the Stop hook.
 * Kills the PTY; the onBeforeExit handler then marks the item done.
 */
export function completeSupervisorItem(itemId: string): void {
  const item = state.items.find((i) => i.id === itemId);
  if (!item || item.status !== 'running') return;
  completedItems.add(itemId);
  const ptySessionId = sessionIds.get(itemId);
  if (ptySessionId) {
    killSession(ptySessionId);
  }
}

async function spawnProcess(item: SupervisorItem): Promise<void> {
  const config = loadConfig();
  const repo = config.repos.find((r) => r.id === item.repoId);
  if (!repo) throw new Error(`Repo not found: ${item.repoId}`);
  const window = mainWindow;
  if (!window) throw new Error('Supervisor not initialized');

  // Create worktree if needed
  let worktreePath = item.worktreePath;
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    const created = await createWorktree(repo.path, item.name, repo.defaultBranch);
    worktreePath = created.worktreePath;
    updateItem(item.id, { worktreePath });
    broadcastState();
  }

  const extraEnv: Record<string, string> = {
    BIFROST_CONTEXT: 'supervisor',
    BIFROST_SUPERVISOR_ITEM_ID: item.id,
  };
  const portFile = path.join(os.homedir(), '.bifrost', 'api-port');
  try {
    extraEnv.BIFROST_API_PORT = fs.readFileSync(portFile, 'utf-8').trim();
  } catch {
    /* port file may not exist */
  }

  const args: string[] = [];
  if (config.permissionMode === 'skip-permissions') {
    args.push('--dangerously-skip-permissions');
  }

  const ptySessionId = `supervisor-${item.id}`;

  spawnSession(ptySessionId, 'claude', args, worktreePath, window, {
    extraEnv,
    autoTrust: true,
    prompt: item.noteText,
    onBeforeExit: (buffer, exitCode) => {
      sessionIds.delete(item.id);
      const completed = completedItems.delete(item.id);

      // Item may have been paused/opened/removed while running — check current status
      const current = state.items.find((i) => i.id === item.id);
      if (!current || current.status !== 'running') return false;

      if (completed || exitCode === 0) {
        updateItem(item.id, { status: 'done', completedAt: Date.now() });
        try {
          updateNote(item.repoId, item.noteId, { addressed: true });
        } catch {
          /* note may have been deleted */
        }
      } else {
        updateItem(item.id, {
          status: 'error',
          errorMessage: buffer.trim().slice(-500) || `claude exited with code ${exitCode}`,
          completedAt: Date.now(),
        });
      }
      broadcastState();
      processQueue();
      return false;
    },
  });

  sessionIds.set(item.id, ptySessionId);
}
