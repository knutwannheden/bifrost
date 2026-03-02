import { execFile } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from './config';

export function openInIde(
  worktreePath: string,
  ide?: 'code' | 'idea' | 'zed',
  filePath?: string,
  line?: number,
): Promise<void> {
  const resolved = ide ?? loadConfig().ide;
  const command = resolved === 'idea' ? 'idea' : resolved === 'zed' ? 'zed' : 'code';

  // Resolve relative file paths to absolute
  const absFile = filePath ? path.resolve(worktreePath, filePath) : undefined;

  const args = [worktreePath];
  if (absFile) {
    if (resolved === 'idea') {
      if (line) args.push('--line', String(line));
      args.push(absFile);
    } else {
      // VS Code (--goto file:line) and Zed (file:line) both use file:line syntax
      if (line) {
        if (resolved === 'zed') {
          args.push(`${absFile}:${line}`);
        } else {
          args.push('--goto', `${absFile}:${line}`);
        }
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
