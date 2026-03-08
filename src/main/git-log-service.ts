import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitLogEntry } from '../shared/types';

const execFile = promisify(execFileCb);

const FORMAT = '%H%x00%h%x00%s%x00%aN%x00%aI';
const MAX_ENTRIES = 200;
const GIT_TIMEOUT_MS = 15000;

export async function getGitLog(worktreePath: string, baseBranch?: string): Promise<GitLogEntry[]> {
  try {
    // Show commits on the worktree branch that aren't on the base branch
    let stdout: string;
    if (baseBranch) {
      try {
        ({ stdout } = await execFile(
          'git',
          ['log', `--format=${FORMAT}`, `--max-count=${MAX_ENTRIES}`, `${baseBranch}..HEAD`],
          { cwd: worktreePath, maxBuffer: 5 * 1024 * 1024, timeout: GIT_TIMEOUT_MS },
        ));
      } catch {
        // Base branch not available — fall back to full log
        ({ stdout } = await execFile('git', ['log', `--format=${FORMAT}`, `--max-count=${MAX_ENTRIES}`], {
          cwd: worktreePath,
          maxBuffer: 5 * 1024 * 1024,
          timeout: GIT_TIMEOUT_MS,
        }));
      }
    } else {
      ({ stdout } = await execFile('git', ['log', `--format=${FORMAT}`, `--max-count=${MAX_ENTRIES}`], {
        cwd: worktreePath,
        maxBuffer: 5 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
      }));
    }

    if (!stdout.trim()) return [];

    return stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [sha, shortSha, subject, author, date] = line.split('\0');
        return { sha, shortSha, subject, author, date };
      });
  } catch {
    return [];
  }
}
