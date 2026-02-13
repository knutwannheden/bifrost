import { execFile } from 'node:child_process';
import { loadConfig } from './config';

export function openInIde(
  worktreePath: string,
  ide?: 'code' | 'idea',
): Promise<void> {
  const resolved = ide ?? loadConfig().ide;
  const command = resolved === 'idea' ? 'idea' : 'code';

  return new Promise((resolve, reject) => {
    execFile(command, [worktreePath], (error) => {
      if (error) {
        reject(
          new Error(
            `Failed to open ${worktreePath} in ${command}: ${error.message}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
