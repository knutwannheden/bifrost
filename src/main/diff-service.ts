import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type { DiffResult, DiffStats } from '../shared/types';

const execFile = promisify(execFileCb);

async function revParse(worktreePath: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd: worktreePath,
      timeout: 5000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The ref to measure a branch against. A local branch name resolves, so a task
 * recorded as forked from `main` would otherwise be compared against whatever
 * the local ref happens to point at rather than what the remote holds.
 */
export async function resolveBaseRef(worktreePath: string, baseBranch: string): Promise<string | null> {
  if (baseBranch.includes('/')) return (await revParse(worktreePath, baseBranch)) ? baseBranch : null;
  for (const candidate of [`origin/${baseBranch}`, `upstream/${baseBranch}`, baseBranch]) {
    if (await revParse(worktreePath, candidate)) return candidate;
  }
  return null;
}

/**
 * The commit a branch's changes are measured from. Merging the base in leaves
 * the working tree holding the base's commits while HEAD still predates them,
 * so during a merge the tree — not HEAD — says what has already been absorbed.
 */
export async function resolveDiffBase(worktreePath: string, baseRef: string): Promise<string | null> {
  const mergeHead = await revParse(worktreePath, 'MERGE_HEAD');
  try {
    const { stdout } = await execFile('git', ['merge-base', baseRef, mergeHead ?? 'HEAD'], {
      cwd: worktreePath,
      timeout: 10000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getDiff(
  worktreePath: string,
  baseBranch?: string,
  scope: 'working' | 'all' = 'working',
): Promise<DiffResult> {
  try {
    // Determine git diff command based on scope
    let diffArgs: string[];
    const base = scope === 'all' && baseBranch ? await resolveDiffBase(worktreePath, baseBranch) : null;
    if (base) {
      // Base against working tree: committed, staged and unstaged alike
      diffArgs = ['--no-optional-locks', 'diff', base];
    } else {
      diffArgs = ['--no-optional-locks', 'diff', 'HEAD'];
    }

    // Get diff for tracked files
    const { stdout: trackedDiff } = await execFile('git', diffArgs, {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30000,
    });

    // Get untracked files and generate synthetic diffs
    let untrackedDiff = '';
    try {
      const { stdout: untrackedOutput } = await execFile(
        'git',
        ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'],
        {
          cwd: worktreePath,
          timeout: 10000,
        },
      );
      const untrackedFiles = untrackedOutput.trim().split('\n').filter(Boolean);

      for (const file of untrackedFiles) {
        const fullPath = path.resolve(worktreePath, file);
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() || stat.size > 1024 * 1024) continue; // skip dirs and large files

        try {
          // Check for binary content (null bytes in first 8KB)
          const fd = fs.openSync(fullPath, 'r');
          const probe = Buffer.alloc(8192);
          const bytesRead = fs.readSync(fd, probe, 0, probe.length, 0);
          fs.closeSync(fd);
          if (probe.subarray(0, bytesRead).includes(0)) {
            untrackedDiff += `diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ\n`;
            continue;
          }

          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          untrackedDiff += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`;
          untrackedDiff += `${lines.map((l) => `+${l}`).join('\n')}\n`;
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // ignore errors listing untracked files
    }

    const diff = trackedDiff + untrackedDiff;

    return { worktreePath, diff };
  } catch {
    return { worktreePath, diff: '' };
  }
}

export type GitFileStage = 'unstaged' | 'staged' | 'committed' | 'untracked';

export async function getFileStatuses(
  worktreePath: string,
  baseBranch?: string,
): Promise<Record<string, GitFileStage[]>> {
  const result: Record<string, GitFileStage[]> = {};

  const addStage = (filePath: string, stage: GitFileStage) => {
    if (!result[filePath]) result[filePath] = [];
    if (!result[filePath].includes(stage)) result[filePath].push(stage);
  };

  // Unstaged tracked changes
  try {
    const { stdout } = await execFile('git', ['--no-optional-locks', 'diff', '--name-only'], {
      cwd: worktreePath,
      timeout: 10000,
    });
    for (const f of stdout.trim().split('\n').filter(Boolean)) addStage(f, 'unstaged');
  } catch {
    /* ignore */
  }

  // Staged changes
  try {
    const { stdout } = await execFile('git', ['--no-optional-locks', 'diff', '--cached', '--name-only'], {
      cwd: worktreePath,
      timeout: 10000,
    });
    for (const f of stdout.trim().split('\n').filter(Boolean)) addStage(f, 'staged');
  } catch {
    /* ignore */
  }

  // Untracked files
  try {
    const { stdout } = await execFile('git', ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'], {
      cwd: worktreePath,
      timeout: 10000,
    });
    for (const f of stdout.trim().split('\n').filter(Boolean)) addStage(f, 'untracked');
  } catch {
    /* ignore */
  }

  // Committed changes since the base, measured from the same commit as the diff
  if (baseBranch) {
    const base = await resolveDiffBase(worktreePath, baseBranch);
    if (base) {
      try {
        const { stdout } = await execFile('git', ['--no-optional-locks', 'diff', '--name-only', base, 'HEAD'], {
          cwd: worktreePath,
          timeout: 10000,
        });
        for (const f of stdout.trim().split('\n').filter(Boolean)) addStage(f, 'committed');
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}

export async function getDiffStats(
  worktreePath: string,
  baseBranch?: string,
  scope: 'working' | 'all' = 'working',
): Promise<DiffStats | null> {
  // A task outlives its worktree; git would fail here at the cost of a spawn.
  if (!fs.existsSync(worktreePath)) return null;

  try {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    // Determine diff base based on scope
    const base = scope === 'all' && baseBranch ? await resolveDiffBase(worktreePath, baseBranch) : null;
    const diffArgs = base
      ? ['--no-optional-locks', 'diff', '--shortstat', base]
      : ['--no-optional-locks', 'diff', '--shortstat', 'HEAD'];

    // Get stats for tracked changes
    try {
      const { stdout } = await execFile('git', diffArgs, {
        cwd: worktreePath,
        timeout: 10000,
      });
      const trimmed = stdout.trim();
      if (trimmed) {
        const filesMatch = trimmed.match(/(\d+) file/);
        const addMatch = trimmed.match(/(\d+) insertion/);
        const delMatch = trimmed.match(/(\d+) deletion/);
        if (filesMatch) filesChanged += parseInt(filesMatch[1], 10);
        if (addMatch) additions += parseInt(addMatch[1], 10);
        if (delMatch) deletions += parseInt(delMatch[1], 10);
      }
    } catch {
      // no tracked changes
    }

    // Count untracked file additions
    try {
      const { stdout: untrackedOutput } = await execFile(
        'git',
        ['--no-optional-locks', 'ls-files', '--others', '--exclude-standard'],
        {
          cwd: worktreePath,
          timeout: 10000,
        },
      );
      const untrackedFiles = untrackedOutput.trim().split('\n').filter(Boolean);

      for (const file of untrackedFiles) {
        const fullPath = path.resolve(worktreePath, file);
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() || stat.size > 1024 * 1024) continue;

        try {
          const stream = fs.createReadStream(fullPath, { encoding: 'utf-8' });
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          let lineCount = 0;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _ of rl) lineCount++;
          additions += lineCount;
          filesChanged++;
        } catch {
          // skip binary or unreadable files
        }
      }
    } catch {
      // ignore errors listing untracked files
    }

    if (filesChanged === 0 && additions === 0 && deletions === 0) return null;
    return { additions, deletions, filesChanged };
  } catch {
    return null;
  }
}
