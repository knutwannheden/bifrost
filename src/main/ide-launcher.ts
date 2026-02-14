import { execFile } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from './config';

export function openInIde(
  worktreePath: string,
  ide?: 'code' | 'idea',
  filePath?: string,
  line?: number,
): Promise<void> {
  const resolved = ide ?? loadConfig().ide;
  const command = resolved === 'idea' ? 'idea' : 'code';

  // Resolve relative file paths to absolute
  const absFile = filePath ? path.resolve(worktreePath, filePath) : undefined;

  const args = [worktreePath];
  if (absFile) {
    if (resolved === 'idea') {
      if (line) args.push('--line', String(line));
      args.push(absFile);
    } else {
      // VS Code: --goto supports file:line:col
      if (line) {
        args.push('--goto', `${absFile}:${line}`);
      } else {
        args.push(absFile);
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
