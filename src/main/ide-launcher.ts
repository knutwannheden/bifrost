import { execFile } from 'node:child_process';
import { loadConfig } from './config';

export function openInIde(
  worktreePath: string,
  ide?: 'code' | 'idea',
  filePath?: string,
  line?: number,
): Promise<void> {
  const resolved = ide ?? loadConfig().ide;
  const command = resolved === 'idea' ? 'idea' : 'code';

  const args = [worktreePath];
  if (filePath) {
    if (resolved === 'idea') {
      if (line) args.push('--line', String(line));
      args.push(filePath);
    } else {
      // VS Code: --goto supports file:line:col
      if (line) {
        args.push('--goto', `${filePath}:${line}`);
      } else {
        args.push(filePath);
      }
    }
  }

  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
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
