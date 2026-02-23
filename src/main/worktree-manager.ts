import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getRemotes } from './repo-manager';

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

  const remoteMatch = branch.match(/^([^/]+)\/(.+)$/);

  await execFile('git', ['worktree', 'add', worktreePath, '-b', taskName, branch], {
    cwd: repoPath,
  });

  // Set upstream tracking when branching from a remote tracking branch
  if (remoteMatch) {
    await execFile(
      'git',
      ['branch', '--set-upstream-to', branch, taskName],
      { cwd: worktreePath },
    );
  }

  return worktreePath;
}

export async function createWorktreeFromPr(
  repoPath: string,
  taskName: string,
  prInfo: import('../shared/types').PrInfo,
  localWorktrees?: boolean,
): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName, localWorktrees);

  if (localWorktrees) {
    await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });
  }

  // Find which remote hosts the PR head branch
  const headGhPath = prInfo.headRepoOwner && prInfo.headRepoName
    ? `${prInfo.headRepoOwner}/${prInfo.headRepoName}`
    : '';
  let remoteName = 'origin';

  if (headGhPath) {
    const remotes = await getRemotes(repoPath);
    const match = remotes.find(
      (r) => r.githubPath.toLowerCase() === headGhPath.toLowerCase(),
    );
    if (match) {
      remoteName = match.name;
    } else {
      // Add a new remote for the fork
      const url = `https://github.com/${headGhPath}.git`;
      remoteName = prInfo.headRepoOwner;
      // Check if a remote with this name already exists but points elsewhere
      const existing = remotes.find((r) => r.name === remoteName);
      if (existing) {
        // Name collision — use owner-repo as the remote name
        remoteName = `${prInfo.headRepoOwner}-${prInfo.headRepoName}`;
      }
      try {
        await execFile('git', ['remote', 'get-url', remoteName], { cwd: repoPath });
      } catch {
        await execFile('git', ['remote', 'add', remoteName, url], { cwd: repoPath });
      }
    }
  }

  await execFile('git', ['fetch', remoteName, prInfo.headBranch], { cwd: repoPath });
  await execFile(
    'git',
    ['worktree', 'add', worktreePath, '-b', taskName, `${remoteName}/${prInfo.headBranch}`],
    { cwd: repoPath },
  );
  await execFile(
    'git',
    ['branch', '--set-upstream-to', `${remoteName}/${prInfo.headBranch}`, taskName],
    { cwd: worktreePath },
  );

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
