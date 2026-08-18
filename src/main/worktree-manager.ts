import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Repo } from '../shared/types';
import { getRemotes } from './repo-manager';

const execFile = promisify(execFileCb);

/**
 * Whether a worktree holds nothing its base branch does not: no staged,
 * unstaged or untracked changes, and no commits ahead. Only such a directory
 * can be recreated exactly, so only such a directory is safe to remove.
 * Anything unreadable answers false, so a failed check never costs a worktree.
 */
export async function isWorktreeDisposable(worktreePath: string, baseRef: string): Promise<boolean> {
  if (!baseRef || !fs.existsSync(worktreePath)) return false;
  try {
    const { stdout: status } = await execFile('git', ['--no-optional-locks', 'status', '--porcelain'], {
      cwd: worktreePath,
      timeout: 5000,
    });
    if (status.trim().length > 0) return false;
    const { stdout: ahead } = await execFile('git', ['rev-list', '--count', `${baseRef}..HEAD`], {
      cwd: worktreePath,
      timeout: 5000,
    });
    return ahead.trim() === '0';
  } catch {
    return false;
  }
}

/** Sanitize a task name into a valid git branch name / directory name. */
export function slugify(name: string): string {
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
): Promise<{ worktreePath: string; branch: string }> {
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

  return { worktreePath, branch: newBranchName };
}

export async function createWorktreeFromPr(
  repoPath: string,
  taskName: string,
  prInfo: import('../shared/types').PrInfo,
): Promise<{ worktreePath: string; branch: string }> {
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

  return { worktreePath, branch: localBranch };
}

export async function restoreWorktree(repoPath: string, taskName: string, branch?: string): Promise<string> {
  const worktreePath = resolveWorktreePath(repoPath, taskName);

  await fs.promises.mkdir(path.join(repoPath, '.worktrees'), { recursive: true });

  const ref = branch ?? slugify(taskName);
  try {
    await execFile('git', ['worktree', 'add', worktreePath, ref], { cwd: repoPath, timeout: 30000 });
  } catch (err) {
    throw new Error(
      `Cannot restore worktree for "${taskName}": no branch named "${ref}". ` +
        `This task predates branch tracking, so its branch must be selected manually.`,
      { cause: err },
    );
  }

  return worktreePath;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execFile('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoPath,
    timeout: 30000,
  });
}

/**
 * Create a multi-repo container: git init a directory, then create worktrees
 * from each selected repo as subdirectories.
 *
 * Returns the container path and a mapping of repo IDs to their worktree directories.
 */
export async function createMultiRepoContainer(
  taskSlug: string,
  repos: Repo[],
): Promise<{ containerPath: string; repoWorktrees: Map<string, string> }> {
  const containerPath = path.join(os.homedir(), '.bifrost', 'multi-tasks', taskSlug);
  await fs.promises.mkdir(containerPath, { recursive: true });

  // Init container repo
  await execFile('git', ['init'], { cwd: containerPath, timeout: 10000 });

  const repoWorktrees = new Map<string, string>();
  const dirNames: string[] = [];
  const dirNameSet = new Set<string>();
  const branchNames: string[] = []; // actual resolved branch names per repo
  const createdWorktrees: string[] = [];

  try {
    for (const repo of repos) {
      // Disambiguate directory names
      let dirName = repo.name;
      if (dirNameSet.has(dirName)) {
        let suffix = 2;
        while (dirNameSet.has(`${dirName}-${suffix}`)) suffix++;
        dirName = `${dirName}-${suffix}`;
      }
      dirNameSet.add(dirName);
      dirNames.push(dirName);

      const worktreePath = path.join(containerPath, dirName);
      const branchName = await resolveAvailableBranchName(repo.path, taskSlug);
      branchNames.push(branchName);

      await execFile('git', ['worktree', 'add', worktreePath, '-b', branchName, repo.defaultBranch], {
        cwd: repo.path,
        timeout: 30000,
      });
      createdWorktrees.push(worktreePath);
      repoWorktrees.set(repo.id, worktreePath);
    }

    // Write .gitignore
    const gitignoreContent = `${dirNames.join('\n')}\n`;
    await fs.promises.writeFile(path.join(containerPath, '.gitignore'), gitignoreContent);

    // Write CLAUDE.md
    const claudeMd = generateMultiRepoClaudeMd(taskSlug, repos, dirNames, branchNames);
    await fs.promises.writeFile(path.join(containerPath, 'CLAUDE.md'), claudeMd);

    // Commit initial state
    await execFile('git', ['add', '.gitignore', 'CLAUDE.md'], { cwd: containerPath, timeout: 10000 });
    await execFile('git', ['commit', '-m', 'Initial multi-repo task setup'], {
      cwd: containerPath,
      timeout: 10000,
    });
  } catch (err) {
    // Rollback: remove any worktrees we created
    for (const wt of createdWorktrees) {
      try {
        const dotGit = await fs.promises.readFile(path.join(wt, '.git'), 'utf-8');
        const gitDirMatch = dotGit.match(/gitdir:\s*(.+)/);
        if (gitDirMatch) {
          const gitDir = path.resolve(wt, gitDirMatch[1].trim());
          // .git/worktrees/<name> → .git is 2 levels up
          const parentGitDir = path.resolve(gitDir, '..', '..');
          const parentRepoPath = path.dirname(parentGitDir);
          await execFile('git', ['worktree', 'remove', wt, '--force'], {
            cwd: parentRepoPath,
            timeout: 10000,
          });
        }
      } catch {
        /* best effort cleanup */
      }
    }
    // Remove container directory
    await fs.promises.rm(containerPath, { recursive: true, force: true });
    throw err;
  }

  return { containerPath, repoWorktrees };
}

function generateMultiRepoClaudeMd(taskSlug: string, repos: Repo[], dirNames: string[], branchNames: string[]): string {
  const lines: string[] = [
    `# Multi-Repo Task: ${taskSlug}`,
    '',
    'This is a multi-repo task managed by Bifrost. Each subdirectory is a git worktree',
    'from a separate repository.',
    '',
    '## Repos',
    '',
    '| Directory | Repository | Branch |',
    '|-----------|-----------|--------|',
  ];

  for (let idx = 0; idx < repos.length; idx++) {
    const repo = repos[idx];
    const dir = dirNames[idx];
    const branch = branchNames[idx];
    lines.push(`| \`${dir}/\` | ${repo.path} | \`${branch}\` (from \`${repo.defaultBranch}\`) |`);
  }

  lines.push('');
  lines.push('Make changes in the repo subdirectories, not in this root directory.');
  lines.push('Each subdirectory has its own git history — commit changes within each repo directory separately.');
  lines.push('Do not run git commands (commit, push, etc.) from this root directory.');
  lines.push('');

  return lines.join('\n');
}

/**
 * Remove all constituent worktrees and delete the container directory.
 * Each subdirectory's .git file is read to find the parent repo for worktree removal.
 */
export async function cleanupMultiRepoContainer(containerPath: string): Promise<void> {
  // Find and remove each constituent worktree
  const entries = await fs.promises.readdir(containerPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.git') continue;
    const subPath = path.join(containerPath, entry.name);
    const dotGitPath = path.join(subPath, '.git');

    try {
      const stat = await fs.promises.stat(dotGitPath);
      if (!stat.isFile()) continue; // worktrees have .git as a file, not a directory

      const dotGit = await fs.promises.readFile(dotGitPath, 'utf-8');
      const gitDirMatch = dotGit.match(/gitdir:\s*(.+)/);
      if (!gitDirMatch) continue;

      const gitDir = path.resolve(subPath, gitDirMatch[1].trim());
      // .git/worktrees/<name> → .git is 2 levels up
      const parentGitDir = path.resolve(gitDir, '..', '..');
      const parentRepoPath = path.dirname(parentGitDir);

      await execFile('git', ['worktree', 'remove', subPath, '--force'], {
        cwd: parentRepoPath,
        timeout: 30000,
      });
    } catch {
      // Best effort — worktree may already be removed
    }
  }

  // Delete the container directory
  await fs.promises.rm(containerPath, { recursive: true, force: true });
}
