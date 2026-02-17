import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFile = promisify(execFileCb);

function resolveWorktreePath(repoPath: string, taskName: string, local?: boolean): string {
  if (local) {
    return path.join(repoPath, '.worktrees', taskName);
  }
  return path.join(os.homedir(), '.bifrost', 'worktrees', path.basename(repoPath), taskName);
}

export async function createWorktree(
  repoPath: string,
  taskName: string,
  branch: string,
  localWorktrees?: boolean,
): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName, localWorktrees);

  if (localWorktrees) {
    await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });
  }

  await execFile('git', ['worktree', 'add', worktreePath, '-b', taskName, branch], {
    cwd: repoPath,
  });

  return worktreePath;
}

export async function restoreWorktree(
  repoPath: string,
  taskName: string,
  localWorktrees?: boolean,
): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName, localWorktrees);

  if (localWorktrees) {
    await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });
  }

  await execFile('git', ['worktree', 'add', worktreePath, taskName], {
    cwd: repoPath,
  });

  return worktreePath;
}

export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<void> {
  await execFile('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
  });
}
