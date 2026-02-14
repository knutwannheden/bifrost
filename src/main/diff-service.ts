import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DiffResult } from '../shared/types';

const execFile = promisify(execFileCb);

export async function getDiff(worktreePath: string): Promise<DiffResult> {
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

    return { worktreePath, diff: trackedDiff + untrackedDiff };
  } catch {
    return { worktreePath, diff: '' };
  }
}
