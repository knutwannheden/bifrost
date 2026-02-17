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

export async function createWorktreeFromPr(
  repoPath: string,
  taskName: string,
  prInfo: import('../shared/types').PrInfo,
): Promise<string> {
  const repoName = path.basename(repoPath);
  const worktreePath = path.join(
    os.homedir(),
    '.bifrost',
    'worktrees',
    repoName,
    taskName,
  );

  if (prInfo.isFork && prInfo.headRepoOwner) {
    // Add fork remote if not already present
    const remoteName = prInfo.headRepoOwner;
    try {
      await execFile('git', ['remote', 'get-url', remoteName], { cwd: repoPath });
    } catch {
      // Remote doesn't exist, add it
      const url = `https://github.com/${prInfo.headRepoOwner}/${prInfo.headRepoName}.git`;
      await execFile('git', ['remote', 'add', remoteName, url], { cwd: repoPath });
    }
    await execFile('git', ['fetch', remoteName, prInfo.headBranch], { cwd: repoPath });
    await execFile(
      'git',
      ['worktree', 'add', worktreePath, '-b', taskName, `${remoteName}/${prInfo.headBranch}`],
      { cwd: repoPath },
    );
    // Set upstream for pulling updates
    await execFile(
      'git',
      ['branch', '--set-upstream-to', `${remoteName}/${prInfo.headBranch}`, taskName],
      { cwd: worktreePath },
    );
  } else {
    // Same-repo PR — fetch branch from origin
    await execFile('git', ['fetch', 'origin', prInfo.headBranch], { cwd: repoPath });
    await execFile(
      'git',
      ['worktree', 'add', worktreePath, '-b', taskName, `origin/${prInfo.headBranch}`],
      { cwd: repoPath },
    );
    await execFile(
      'git',
      ['branch', '--set-upstream-to', `origin/${prInfo.headBranch}`, taskName],
      { cwd: worktreePath },
    );
  }

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
