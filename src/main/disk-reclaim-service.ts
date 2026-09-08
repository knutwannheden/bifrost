import fs from 'node:fs';
import type { BrowserWindow } from 'electron';

import { IPC_STREAM } from '../shared/ipc-channels';
import type { DiskReclaimResult, DiskReclaimScan, Repo, Task } from '../shared/types';
import { loadConfig, saveConfig } from './config';
import { type OwningTask, runGit, type ScanRepo, scanRepos, sizeKb, stillReclaimable } from './disk-reclaim-scan';
import { archiveTaskCore, getTasks } from './ipc-handlers';
import { hasSession } from './session-manager';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the window has to have been away for this to read as a fresh start. */
const AWAY_MS = 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let lastBlurAt = Date.now();
let scanning = false;

/** Repos Bifrost manages, minus the synthetic containers of multi-repo tasks. */
function scannableRepos(): ScanRepo[] {
  return (loadConfig().repos as Repo[])
    .filter((r) => !r.multiTaskId)
    .map((r) => ({ id: r.id, name: r.name, path: r.path }));
}

function taskLookup(): (worktreePath: string) => OwningTask | undefined {
  const byWorktree = new Map(getTasks().map((t) => [t.worktreePath, t]));
  return (worktreePath: string) => {
    const task = byWorktree.get(worktreePath);
    if (!task) return undefined;
    return {
      id: task.id,
      name: task.name,
      prMerged: task.curation?.prState === 'merged' || task.curation?.branchMerged === true,
      hasLiveSession: hasSession(task.id),
    };
  };
}

export async function scanReclaimable(): Promise<DiskReclaimScan> {
  const scan = await scanRepos(scannableRepos(), taskLookup());
  saveConfig({ ...loadConfig(), lastDiskScanAt: scan.scannedAt });
  return scan;
}

/**
 * Remove the candidates that still qualify. Work can start in a worktree between
 * the scan and the click, so each one is re-judged here, and removal runs
 * without --force, leaving git a veto of its own.
 */
export async function applyReclaim(worktreePaths: string[]): Promise<DiskReclaimResult> {
  const repos = scannableRepos();
  const lookup = taskLookup();
  const tasksById = new Map(getTasks().map((t) => [t.id, t]));
  const result: DiskReclaimResult = { freedKb: 0, removed: 0, archivedTasks: 0, skipped: 0 };

  for (const worktreePath of worktreePaths) {
    const repo = repos.find((r) => worktreePath.startsWith(`${r.path}/`));
    if (!repo || !fs.existsSync(worktreePath)) {
      result.skipped++;
      continue;
    }

    const owner = lookup(worktreePath);
    if (!(await stillReclaimable(repo.path, worktreePath, owner))) {
      result.skipped++;
      continue;
    }

    const kb = await sizeKb(worktreePath);
    const task: Task | undefined = owner ? tasksById.get(owner.id) : undefined;
    if (task && task.status !== 'archived') {
      try {
        await archiveTaskCore(task.id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.TASK_CLOSED, task.id, true);
        }
        result.archivedTasks++;
      } catch {
        result.skipped++;
        continue;
      }
    }

    // Archiving keeps the worktree of a task with no branch to rebuild it from,
    // so the directory going is what counts as freed, not the action succeeding.
    if (fs.existsSync(worktreePath)) {
      await runGit(repo.path, ['worktree', 'remove', worktreePath]);
    }
    if (fs.existsSync(worktreePath)) {
      result.skipped++;
      continue;
    }

    result.removed++;
    result.freedKb += kb;
  }

  for (const repo of repos) {
    await runGit(repo.path, ['worktree', 'prune']);
  }
  return result;
}

/** A scan is worth offering once a day, when the user comes back to the app. */
function shouldScanOnFocus(): boolean {
  if (scanning) return false;
  if (Date.now() - lastBlurAt < AWAY_MS) return false;
  return Date.now() - (loadConfig().lastDiskScanAt ?? 0) >= DAY_MS;
}

async function scanAndOffer(): Promise<void> {
  scanning = true;
  try {
    const scan = await scanReclaimable();
    if (scan.candidates.length === 0) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_STREAM.DISK_RECLAIM_READY, scan);
    }
  } catch (err) {
    console.error('[disk-reclaim] scan failed:', err);
  } finally {
    scanning = false;
  }
}

export function initDiskReclaim(window: BrowserWindow): void {
  mainWindow = window;
  window.on('blur', () => {
    lastBlurAt = Date.now();
  });
  window.on('focus', () => {
    if (shouldScanOnFocus()) void scanAndOffer();
  });
}
