import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const execFile = promisify(execFileCb);

export async function createWorktree(
  repoPath: string,
  taskName: string,
  branch: string,
): Promise<string> {
  const repoName = path.basename(repoPath);
  const worktreePath = path.join(
    os.homedir(),
    '.bifrost',
    'worktrees',
    repoName,
    taskName,
  );

  await execFile('git', ['worktree', 'add', worktreePath, '-b', taskName, branch], {
    cwd: repoPath,
  });

  return worktreePath;
}

export async function restoreWorktree(
  repoPath: string,
  taskName: string,
): Promise<string> {
  const repoName = path.basename(repoPath);
  const worktreePath = path.join(
    os.homedir(),
    '.bifrost',
    'worktrees',
    repoName,
    taskName,
  );

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
