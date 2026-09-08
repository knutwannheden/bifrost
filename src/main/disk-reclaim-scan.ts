import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import type { DiskReclaimCandidate, DiskReclaimScan } from '../shared/types';
import { isReclaimable, parseWorktrees, type WorktreeEntry, type WorktreeFacts } from './disk-reclaim-policy';

const execFile = promisify(execFileCb);

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a worktree's owning task contributes to the decision, if a task owns it. */
export interface OwningTask {
  id: string;
  name: string;
  prMerged: boolean;
  hasLiveSession: boolean;
}

export interface ScanRepo {
  id: string;
  name: string;
  path: string;
}

export async function runGit(cwd: string, args: string[], timeout = 15_000): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', args, { cwd, timeout });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** The origin default branch, e.g. "origin/main"; undefined if origin has none. */
async function originDefault(repoPath: string): Promise<string | undefined> {
  const head = await runGit(repoPath, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head;
  for (const candidate of ['origin/main', 'origin/master']) {
    if ((await runGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/remotes/${candidate}`])) !== null) {
      return candidate;
    }
  }
  return undefined;
}

/** Whether HEAD survives removal: merged into the default branch, or on a remote. */
async function isReachable(repoPath: string, head: string | undefined, def: string | undefined): Promise<boolean> {
  if (!head) return false;
  if (def && (await runGit(repoPath, ['merge-base', '--is-ancestor', head, def])) !== null) return true;
  const onRemote = await runGit(repoPath, [
    'for-each-ref',
    '--contains',
    head,
    '--format=%(refname)',
    '--count=1',
    'refs/remotes/',
  ]);
  return !!onRemote && !onRemote.endsWith('/HEAD');
}

/** Days since git last wrote the index, so any git command counts as use. */
async function idleDays(worktreePath: string): Promise<number> {
  const gitDir = await runGit(worktreePath, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir) return 0;
  try {
    const { mtimeMs } = fs.statSync(`${gitDir}/index`);
    return Math.floor((Date.now() - mtimeMs) / DAY_MS);
  } catch {
    return 0;
  }
}

async function factsFor(repoPath: string, entry: WorktreeEntry, task: OwningTask | undefined) {
  const status = await runGit(worktreeOrRepo(entry, repoPath), [
    '--no-optional-locks',
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  const facts: Omit<WorktreeFacts, 'reachable'> = {
    isMain: entry.isMain,
    locked: entry.locked,
    hasLiveSession: task?.hasLiveSession === true,
    // An unreadable status is treated as dirty: nothing is deleted on a guess.
    dirty: status === null || status.length > 0,
    idleDays: await idleDays(entry.path),
    prMerged: task?.prMerged === true,
  };
  return facts;
}

function worktreeOrRepo(entry: WorktreeEntry, repoPath: string): string {
  return fs.existsSync(entry.path) ? entry.path : repoPath;
}

export async function sizeKb(dir: string): Promise<number> {
  try {
    const { stdout } = await execFile('du', ['-sk', dir], { timeout: 120_000 });
    return Number.parseInt(stdout.trim().split(/\s+/)[0], 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Judge every linked worktree in these repos. Sizes are measured for candidates
 * alone, since du over a worktree tree is the slow part of the scan.
 */
export async function scanRepos(
  repos: ScanRepo[],
  taskFor: (worktreePath: string) => OwningTask | undefined,
): Promise<DiskReclaimScan> {
  const candidates: DiskReclaimCandidate[] = [];
  let keptDirty = 0;

  for (const repo of repos) {
    const porcelain = await runGit(repo.path, ['worktree', 'list', '--porcelain']);
    if (!porcelain) continue;
    const def = await originDefault(repo.path);

    for (const entry of parseWorktrees(porcelain)) {
      if (entry.isMain || !fs.existsSync(entry.path)) continue;
      const task = taskFor(entry.path);
      const facts = await factsFor(repo.path, entry, task);
      if (!isReclaimable({ ...facts, reachable: await isReachable(repo.path, entry.head, def) })) {
        if (facts.dirty) keptDirty++;
        continue;
      }
      candidates.push({
        worktreePath: entry.path,
        repoId: repo.id,
        repoName: repo.name,
        branch: entry.branch,
        taskId: task?.id,
        taskName: task?.name,
        sizeKb: await sizeKb(entry.path),
        idleDays: facts.idleDays,
        prMerged: facts.prMerged,
      });
    }
  }

  candidates.sort((a, b) => b.sizeKb - a.sizeKb);
  return {
    scannedAt: Date.now(),
    candidates,
    totalKb: candidates.reduce((sum, c) => sum + c.sizeKb, 0),
    keptDirty,
  };
}

/** Re-judge one worktree, for confirming a candidate still qualifies. */
export async function stillReclaimable(
  repoPath: string,
  worktreePath: string,
  task: OwningTask | undefined,
): Promise<boolean> {
  const porcelain = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
  const entry = porcelain ? parseWorktrees(porcelain).find((e) => e.path === worktreePath) : undefined;
  if (!entry) return false;
  const facts = await factsFor(repoPath, entry, task);
  return isReclaimable({ ...facts, reachable: await isReachable(repoPath, entry.head, await originDefault(repoPath)) });
}
