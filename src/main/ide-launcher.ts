import { execFile } from 'node:child_process';
import path from 'node:path';
import { loadConfig } from './config';

/**
 * Open a file directly in the configured IDE without specifying a project/worktree.
 * This avoids opening a new window when the IDE already has the project open.
 */
export function openFileInIde(filePath: string, line?: number, worktreePath?: string): Promise<void> {
  if (worktreePath) {
    return openInIde(worktreePath, undefined, filePath, line);
  }

  const ide = loadConfig().ide;
  const command = ide === 'idea' ? 'idea' : ide === 'zed' ? 'zed' : 'code';

  const args: string[] = [];
  if (ide === 'idea') {
    if (line) args.push('--line', String(line));
    args.push(filePath);
  } else if (ide === 'zed') {
    args.push(line ? `${filePath}:${line}` : filePath);
  } else {
    // VS Code: --goto file:line or --reuse-window file
    args.push('--reuse-window');
    args.push(line ? '--goto' : '', line ? `${filePath}:${line}` : filePath);
  }

  return new Promise((resolve, reject) => {
    execFile(command, args.filter(Boolean), (error) => {
      if (error) {
        reject(new Error(`Failed to open ${filePath} in ${command}: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

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
