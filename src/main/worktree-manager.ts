import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRemotes } from './repo-manager';

const execFile = promisify(execFileCb);

/** Sanitize a task name into a valid git branch name / directory name. */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, '-') // replace invalid chars with hyphens
      .replace(/\.{2,}/g, '.') // no consecutive dots
      .replace(/(^[./-]+|[./-]+$)/g, '') // no leading/trailing dots, slashes, hyphens
      .replace(/@\{/g, 'at-') // no @{ sequence
      .replace(/\.lock(\/|$)/g, '-lock$1') // no .lock component
      .slice(0, 100) || // reasonable length limit
    'task'
  ); // fallback if nothing remains
}

function resolveWorktreePath(repoPath: string, taskName: string): string {
  return path.join(repoPath, '.worktrees', slugify(taskName));
}

/** Ensure /.worktrees/ is listed in .git/info/exclude so it stays untracked without touching .gitignore. */
async function ensureExcludeEntry(repoPath: string): Promise<void> {
  const excludePath = path.join(repoPath, '.git', 'info', 'exclude');
  const entry = '/.worktrees/';
  try {
    await fs.promises.mkdir(path.dirname(excludePath), { recursive: true });
    let content = '';
    try {
      content = await fs.promises.readFile(excludePath, 'utf-8');
    } catch {
      /* file may not exist */
    }
    if (!content.split('\n').some((line) => line.trim() === entry)) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      await fs.promises.appendFile(excludePath, `${separator}${entry}\n`);
    }
  } catch {
    /* best effort */
  }
}

async function resolveAvailableBranchName(repoPath: string, desired: string): Promise<string> {
  let name = desired;
  for (let suffix = 2; suffix <= 20; suffix++) {
    try {
      await execFile('git', ['rev-parse', '--verify', `refs/heads/${name}`], { cwd: repoPath, timeout: 5000 });
      name = `${desired}-${suffix}`; // branch exists, try next
    } catch {
      return name; // branch doesn't exist, available
    }
  }
  return name;
}

export async function createWorktree(
  repoPath: string,
  taskName: string,
  branch: string,
  branchName?: string,
): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName);

  await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });
  await ensureExcludeEntry(repoPath);

  const remoteMatch = branch.match(/^([^/]+)\/(.+)$/);

  // Fetch the latest remote ref before creating the worktree (best-effort with timeout)
  if (remoteMatch) {
    try {
      await execFile('git', ['fetch', remoteMatch[1], remoteMatch[2]], {
        cwd: repoPath,
        timeout: 15000,
      });
    } catch {
      /* fetch failed/timed out — use local ref */
    }
  }

  const newBranchName = await resolveAvailableBranchName(repoPath, branchName ?? slugify(taskName));

  await execFile('git', ['worktree', 'add', worktreePath, '-b', newBranchName, branch], {
    cwd: repoPath,
    timeout: 30000,
  });

  // Set upstream tracking when branching from a remote tracking branch
  if (remoteMatch) {
    await execFile('git', ['branch', '--set-upstream-to', branch, newBranchName], {
      cwd: worktreePath,
      timeout: 10000,
    });
  }

  return worktreePath;
}

export async function createWorktreeFromPr(
  repoPath: string,
  taskName: string,
  prInfo: import('../shared/types').PrInfo,
): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName);

  await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });
  await ensureExcludeEntry(repoPath);

  // Find which remote hosts the PR head branch
  const headGhPath =
    prInfo.headRepoOwner && prInfo.headRepoName ? `${prInfo.headRepoOwner}/${prInfo.headRepoName}` : '';
  let remoteName = 'origin';

  if (headGhPath) {
    const remotes = await getRemotes(repoPath);
    const match = remotes.find((r) => r.githubPath.toLowerCase() === headGhPath.toLowerCase());
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
        await execFile('git', ['remote', 'get-url', remoteName], { cwd: repoPath, timeout: 10000 });
      } catch {
        await execFile('git', ['remote', 'add', remoteName, url], { cwd: repoPath, timeout: 10000 });
      }
    }
  }

  await execFile('git', ['fetch', remoteName, prInfo.headBranch], { cwd: repoPath, timeout: 30000 });
  const localBranch = slugify(taskName);
  await execFile('git', ['worktree', 'add', worktreePath, '-b', localBranch, `${remoteName}/${prInfo.headBranch}`], {
    cwd: repoPath,
    timeout: 30000,
  });
  await execFile('git', ['branch', '--set-upstream-to', `${remoteName}/${prInfo.headBranch}`, localBranch], {
    cwd: worktreePath,
    timeout: 10000,
  });

  return worktreePath;
}

export async function restoreWorktree(repoPath: string, taskName: string): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName);

  await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });

  await execFile('git', ['worktree', 'add', worktreePath, slugify(taskName)], {
    cwd: repoPath,
    timeout: 30000,
  });

  return worktreePath;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execFile('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
    timeout: 30000,
  });
}
