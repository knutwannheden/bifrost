import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { DiffResult, DiffStats } from '../shared/types';

const execFile = promisify(execFileCb);

export async function getDiff(worktreePath: string, baseBranch?: string): Promise<DiffResult> {
  try {
    // Get diff for tracked files
    const { stdout: trackedDiff } = await execFile('git', ['diff', 'HEAD'], {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Get untracked files and generate synthetic diffs
    let untrackedDiff = '';
    try {
      const { stdout: untrackedOutput } = await execFile(
        'git',
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: worktreePath },
      );
      const untrackedFiles = untrackedOutput.trim().split('\n').filter(Boolean);

      for (const file of untrackedFiles) {
        const fullPath = path.resolve(worktreePath, file);
        if (!fs.existsSync(fullPath)) continue;
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() || stat.size > 1024 * 1024) continue; // skip dirs and large files

        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          untrackedDiff += `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n`;
          untrackedDiff += lines.map((l) => `+${l}`).join('\n') + '\n';
        } catch {
          // skip binary or unreadable files
        }
      }
    } catch {
      // ignore errors listing untracked files
    }

    let diff = trackedDiff + untrackedDiff;

    // If no uncommitted changes, try committed changes since base branch
    if (!diff.trim() && baseBranch) {
      try {
        const { stdout: branchDiff } = await execFile('git', ['diff', `${baseBranch}...HEAD`], {
          cwd: worktreePath,
          maxBuffer: 10 * 1024 * 1024,
        });
        diff = branchDiff;
      } catch { /* base branch may not exist */ }
    }

    return { worktreePath, diff };
  } catch {
    return { worktreePath, diff: '' };
  }
}

export async function getDiffStats(worktreePath: string, baseBranch?: string): Promise<DiffStats | null> {
  try {
    let additions = 0;
    let deletions = 0;
    let filesChanged = 0;

    // Get stats for tracked changes
    try {
      const { stdout } = await execFile('git', ['diff', '--shortstat', 'HEAD'], {
        cwd: worktreePath,
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
        ['ls-files', '--others', '--exclude-standard'],
        { cwd: worktreePath },
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

    // If no uncommitted changes, try committed changes since base branch
    if (filesChanged === 0 && additions === 0 && deletions === 0 && baseBranch) {
      try {
        const { stdout } = await execFile('git', ['diff', '--shortstat', `${baseBranch}...HEAD`], {
          cwd: worktreePath,
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
      } catch { /* base branch may not exist */ }
    }

    if (filesChanged === 0 && additions === 0 && deletions === 0) return null;
    return { additions, deletions, filesChanged };
  } catch {
    return null;
  }
}
