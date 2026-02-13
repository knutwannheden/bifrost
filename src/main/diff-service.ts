import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import type { DiffResult } from '../shared/types';

const execFile = promisify(execFileCb);

export async function getDiff(worktreePath: string): Promise<DiffResult> {
  try {
    const { stdout } = await execFile('git', ['diff', 'HEAD'], {
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { worktreePath, diff: stdout };
  } catch {
    return { worktreePath, diff: '' };
  }
}
