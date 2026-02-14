import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { AddRepoParams, BifrostConfig, Repo } from '../shared/types';

const execFile = promisify(execFileCb);

export async function addRepo(params: AddRepoParams): Promise<Repo> {
  if (params.type === 'local') {
    const repoPath = params.path!;
    const gitDir = path.join(repoPath, '.git');
    if (!fs.existsSync(gitDir)) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }

    const defaultBranch = await getDefaultBranch(repoPath);
    const name = path.basename(repoPath);

    return {
      id: uuidv4(),
      name,
      path: repoPath,
      defaultBranch,
    };
  }

  if (params.type === 'clone') {
    const url = params.url!;
    const repoName = path.basename(url, '.git');
    const os = await import('node:os');
    const clonePath = path.join(os.homedir(), '.bifrost', 'repos', repoName);

    await execFile('git', ['clone', url, clonePath]);
    const defaultBranch = await getDefaultBranch(clonePath);

    return {
      id: uuidv4(),
      name: repoName,
      path: clonePath,
      defaultBranch,
    };
  }

  throw new Error(`Unknown repo type: ${params.type}`);
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
