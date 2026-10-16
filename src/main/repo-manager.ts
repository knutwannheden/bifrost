import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AddRepoParams, BifrostConfig, Repo } from '../shared/types';
import { trustDirectory } from './claude-trust.ts';
import { normalizeRepoPath } from './repo-path.ts';

const execFile = promisify(execFileCb);

/**
 * Which configured repo a caller's `repo` string names, or null for an absolute
 * path no repo holds. A name two directories share is an error rather than a
 * guess, and so is a bare word, which as a relative path would name a directory
 * under wherever the process happens to run.
 */
export function matchRepo(repos: readonly Repo[], input: string): Repo | null {
  const bySlug = repos.find((r) => r.githubPath === input);
  if (bySlug) return bySlug;

  const byName = repos.filter((r) => r.name === input);
  if (byName.length > 0) {
    if (new Set(byName.map((r) => r.path)).size > 1) {
      const slugs = byName.map((r) => r.githubPath ?? r.path).join(', ');
      throw new Error(`Repo name "${input}" matches ${byName.length} repos — use a GitHub slug: ${slugs}`);
    }
    return byName[0];
  }

  if (!path.isAbsolute(input) && !input.startsWith('~')) {
    throw new Error(
      `Unknown repo "${input}" — give a configured repo name, a GitHub slug like "org/repo", or an absolute path`,
    );
  }
  const resolved = normalizeRepoPath(input);
  return repos.find((r) => r.path === resolved) ?? null;
}

export async function addRepo(params: AddRepoParams): Promise<Repo> {
  if (params.type === 'local') {
    const repoPath = normalizeRepoPath(params.path ?? '');
    const gitDir = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    const defaultBranch = await getDefaultBranch(repoPath);
    const name = path.basename(repoPath);
    const githubPath = await getGitHubPath(repoPath);
    // A repo the user just handed to Bifrost is one they trust, and a session
    // stopped on the workspace prompt is one no agent can get past.
    trustDirectory(repoPath);

    return {
      id: randomUUID(),
      name,
      path: repoPath,
      defaultBranch,
      ...(githubPath && { githubPath }),
    };
  }

  if (params.type === 'clone') {
    const url = params.url ?? '';
    const repoName = path.basename(url, '.git');
    const clonePath = path.join(os.homedir(), '.bifrost', 'repos', repoName);

    await execFile('git', ['clone', url, clonePath], { timeout: 120000 });
    const defaultBranch = await getDefaultBranch(clonePath);
    const githubPath = await getGitHubPath(clonePath);
    trustDirectory(clonePath);

    return {
      id: randomUUID(),
      name: repoName,
      path: clonePath,
      defaultBranch,
      ...(githubPath && { githubPath }),
    };
  }

  throw new Error(`Unknown repo type: ${params.type}`);
}

export async function getGitHubPath(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      timeout: 10000,
    });
    const url = stdout.trim();
    // git@github.com:org/repo.git or https://github.com/org/repo.git
    const sshMatch = url.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
  } catch {
    // no remote or not a git repo
  }
  return undefined;
}

/**
 * Detect the default branch for a git repo.
 * Tries: gh CLI (for GitHub repos) → origin/HEAD → main/master existence.
 */
export async function detectBaseBranch(repoPath: string): Promise<string | undefined> {
  // Try gh CLI (most reliable for GitHub repos)
  try {
    const { stdout } = await execFile(
      'gh',
      ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
      { cwd: repoPath, timeout: 5000, killSignal: 'SIGKILL' },
    );
    const branch = stdout.trim();
    if (branch) return branch;
  } catch {
    // gh not installed or not a GitHub repo
  }

  // Try origin/HEAD
  try {
    const { stdout } = await execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath,
      timeout: 10000,
    });
    const branch = stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (branch) return branch;
  } catch {
    // origin/HEAD not set
  }

  // Fall back to checking if main or master exist
  for (const candidate of ['main', 'master']) {
    try {
      await execFile('git', ['rev-parse', '--verify', candidate], {
        cwd: repoPath,
        timeout: 10000,
      });
      return candidate;
    } catch {
      // branch doesn't exist
    }
  }

  return undefined;
}

async function getDefaultBranch(repoPath: string): Promise<string> {
  return (await detectBaseBranch(repoPath)) ?? 'main';
}

export function removeRepo(repoId: string, config: BifrostConfig): BifrostConfig {
  return {
    ...config,
    repos: config.repos.filter((r) => r.id !== repoId),
  };
}

export async function getRemotes(repoPath: string): Promise<Array<{ name: string; githubPath: string }>> {
  try {
    const { stdout } = await execFile('git', ['remote', '-v'], { cwd: repoPath, timeout: 10000 });
    const seen = new Set<string>();
    const remotes: Array<{ name: string; githubPath: string }> = [];
    for (const line of stdout.split('\n')) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const name = parts[0];
      if (seen.has(name)) continue;
      seen.add(name);
      const url = parts[1];
      const sshMatch = url.match(/github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
      if (sshMatch) {
        remotes.push({ name, githubPath: sshMatch[1] });
        continue;
      }
      const httpsMatch = url.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) {
        remotes.push({ name, githubPath: httpsMatch[1] });
      }
    }
    return remotes;
  } catch {
    return [];
  }
}

export async function getRepoBranches(repoPath: string): Promise<string[]> {
  const { stdout } = await execFile('git', ['branch', '-a'], { cwd: repoPath, timeout: 10000 });
  return stdout
    .split('\n')
    .map((line) =>
      line
        .replace(/^\s*[*+]?\s+/, '')
        .replace(/^remotes\//, '')
        .trim(),
    )
    .filter((line) => line.length > 0 && !line.includes('->'));
}
