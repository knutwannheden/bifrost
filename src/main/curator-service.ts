import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';

import { IPC_STREAM } from '../shared/ipc-channels';
import type { CuratorRunResult, CuratorState, Repo, Task, TaskCuration, TaskOutcome } from '../shared/types';
import { loadConfig } from './config';
import { archiveTaskCore, getTasks, updateTask } from './ipc-handlers';
import { isWorktreeDisposable } from './worktree-manager';

const execFile = promisify(execFileCb);

const CURATOR_INTERVAL_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

let curatorState: CuratorState = {
  lastRunAt: null,
  running: false,
  lastRunResults: [],
};

function broadcastCuration(taskId: string, curation: TaskCuration): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.CURATOR_UPDATE, taskId, curation);
  }
}

export function getCuratorState(): CuratorState {
  return curatorState;
}

export function initCurator(window: BrowserWindow): void {
  mainWindow = window;
  setTimeout(() => runCuratorNow(), 30_000);
  timer = setInterval(() => runCuratorNow(), CURATOR_INTERVAL_MS);
}

export function stopCurator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function runCuratorNow(): Promise<void> {
  if (curatorState.running) return;

  const config = loadConfig();
  if (!config.experimentalFeatures) return;

  const tasks = getTasks();
  const hasStoppedClean = tasks.some((t) => t.status === 'stopped' && !t.isExternal && !t.inPlace);
  const hasUnclassified = tasks.some(
    (t) =>
      (t.status === 'stopped' || t.status === 'archived') &&
      !t.curation?.userOverride &&
      t.curation?.confidence !== 'auto',
  );
  if (!hasStoppedClean && !hasUnclassified) return;

  curatorState = { ...curatorState, running: true };
  try {
    await curatorTick();
  } catch (err) {
    console.error('[curator] tick failed:', err);
  } finally {
    curatorState = { ...curatorState, running: false, lastRunAt: Date.now() };
  }
}

async function curatorTick(): Promise<void> {
  const tasks = getTasks();
  const now = Date.now();
  const results: CuratorRunResult[] = [];

  for (const task of tasks) {
    if (task.status !== 'stopped') continue;
    if (task.isExternal || task.inPlace) continue;
    if (!fs.existsSync(task.worktreePath)) continue;

    try {
      if (await isWorktreeDisposable(task.worktreePath, task.baseBranch)) {
        console.log(`[curator] auto-archiving clean stopped task: ${task.name}`);
        const archived = await archiveTaskCore(task.id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.TASK_CLOSED, task.id, true);
        }
        results.push({
          taskId: task.id,
          taskName: task.name,
          action: 'auto-archived',
          timestamp: Date.now(),
        });
        const classResult = await classifyTask(archived);
        if (classResult) results.push(classResult);
      }
    } catch {
      // Archiving or classification failed; the next tick retries.
    }
  }

  const refreshedTasks = getTasks();
  for (const task of refreshedTasks) {
    if (task.status !== 'stopped' && task.status !== 'archived') continue;
    if (now - task.createdAt > MAX_AGE_MS) continue;
    if (task.curation?.userOverride) continue;
    if (task.curation?.confidence === 'auto') continue;

    const result = await classifyTask(task);
    if (result) results.push(result);
  }

  curatorState = { ...curatorState, lastRunResults: results };
}

async function classifyTask(task: Task): Promise<CuratorRunResult | null> {
  const config = loadConfig();
  const repo = config.repos.find((r: Repo) => r.id === task.repoId);
  if (!repo) return null;

  let prState: 'open' | 'closed' | 'merged' | undefined;
  let branchMerged = false;
  let outcome: TaskOutcome = 'pending';
  let reason: string | undefined;

  const ghAvailable = await isGhAvailable();
  if (ghAvailable) {
    try {
      const { stdout } = await execFile(
        'gh',
        ['pr', 'view', task.branch, '--json', 'state,mergedAt', '--jq', '.state'],
        { cwd: repo.path, timeout: 10_000 },
      );
      const state = stdout.trim().toUpperCase();
      if (state === 'MERGED') {
        prState = 'merged';
        outcome = 'merged';
        reason = 'PR merged';
      } else if (state === 'CLOSED') {
        prState = 'closed';
        outcome = 'abandoned';
        reason = 'PR closed without merge';
      } else if (state === 'OPEN') {
        prState = 'open';
        outcome = 'pending';
        reason = 'PR open';
      }
    } catch {
      // No PR found or gh failed
    }
  }

  if (!prState) {
    try {
      // Use -- to separate revision from paths, avoiding ambiguity errors
      const { stdout } = await execFile(
        'git',
        ['branch', '--merged', repo.defaultBranch, '--list', task.branch, '--'],
        { cwd: repo.path, timeout: 5000 },
      );
      if (stdout.trim().length > 0) {
        branchMerged = true;
        outcome = 'merged';
        reason = `Branch merged into ${repo.defaultBranch}`;
      }
    } catch {
      // git branch check failed — defaultBranch may not exist
    }
  }

  if (outcome === 'pending' && !prState && !branchMerged) return null;

  const curation: TaskCuration = {
    outcome,
    confidence: 'auto',
    reason,
    prState,
    branchMerged,
    classifiedAt: Date.now(),
    userOverride: task.curation?.userOverride,
    userNote: task.curation?.userNote,
  };

  updateTask(task.id, { curation });
  broadcastCuration(task.id, curation);

  return {
    taskId: task.id,
    taskName: task.name,
    action: 'classified',
    outcome,
    reason,
    timestamp: Date.now(),
  };
}

let _ghAvailable: boolean | null = null;
let _ghCheckedAt = 0;
const GH_CACHE_MS = 5 * 60 * 1000;

async function isGhAvailable(): Promise<boolean> {
  if (_ghAvailable !== null && Date.now() - _ghCheckedAt < GH_CACHE_MS) return _ghAvailable;
  try {
    await execFile('gh', ['--version'], { timeout: 5000 });
    _ghAvailable = true;
  } catch {
    _ghAvailable = false;
  }
  _ghCheckedAt = Date.now();
  return _ghAvailable;
}
