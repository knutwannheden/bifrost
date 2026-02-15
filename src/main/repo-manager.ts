import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddRepoParams, BifrostConfig, Repo } from '../shared/types';

const execFile = promisify(execFileCb);

export async function addRepo(params: AddRepoParams): Promise<Repo> {
  if (params.type === 'local') {
    const repoPath = params.path ?? '';
    const gitDir = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    const defaultBranch = await getDefaultBranch(repoPath);
    const name = path.basename(repoPath);
    const githubPath = await getGitHubPath(repoPath);

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

    await execFile('git', ['clone', url, clonePath]);
    const defaultBranch = await getDefaultBranch(clonePath);
    const githubPath = await getGitHubPath(clonePath);

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

async function getGitHubPath(repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
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

async function getDefaultBranch(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: repoPath,
    });
    return stdout.trim();
  } catch {
    return 'main';
  }
}

export function removeRepo(
  repoId: string,
  config: BifrostConfig,
): BifrostConfig {
  return {
    ...config,
    repos: config.repos.filter((r) => r.id !== repoId),
  };
}

export async function getRepoBranches(repoPath: string): Promise<string[]> {
  const { stdout } = await execFile('git', ['branch', '-a'], { cwd: repoPath });
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\*?\s+/, '').trim())
    .filter((line) => line.length > 0 && !line.includes('->'));
}
