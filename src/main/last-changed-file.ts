import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** The worktree's most recently modified file among those git reports as changed, or null when it is clean. */
export async function lastChangedFile(worktreePath: string): Promise<string | null> {
  let stdout: string;
  try {
    ({ stdout } = await execFile(
      'git',
      ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd: worktreePath, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 },
    ));
  } catch {
    return null;
  }
  let newest: { file: string; mtime: number } | null = null;
  const records = stdout.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    // A rename or copy is followed by a record holding its source path.
    if (record[0] === 'R' || record[0] === 'C') i++;
    const file = record.slice(3);
    try {
      const mtime = fs.statSync(path.join(worktreePath, file)).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    } catch {
      /* deleted, so there is nothing to open */
    }
  }
  return newest?.file ?? null;
}
