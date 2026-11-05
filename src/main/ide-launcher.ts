import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Machine, Task } from '../shared/types.ts';
import { loadConfig } from './config.ts';

type Ide = 'code' | 'idea' | 'zed';

/** The ssh host of the machine that runs the task whose worktree holds the path, when that is another machine. */
export function remoteHost(filePath: string, tasks: Task[], machines: Machine[]): string | undefined {
  const task = tasks.find(
    (t) => t.worktreePath && (filePath === t.worktreePath || filePath.startsWith(`${t.worktreePath}/`)),
  );
  return task?.machine ? machines.find((m) => m.name === task.machine)?.host : undefined;
}

/**
 * Open a file directly in the configured IDE without specifying a project/worktree.
 * This avoids opening a new window when the IDE already has the project open.
 */
export function openFileInIde(filePath: string, line?: number, worktreePath?: string, host?: string): Promise<void> {
  if (worktreePath) {
    return openInIde(worktreePath, undefined, filePath, line, host);
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

/**
 * The command that opens the worktree, with the file at its line when one is named.
 * On another machine only Zed can, and it takes one ssh URL, so a named file opens on its own.
 */
export function ideCommand(
  ide: Ide,
  worktreePath: string,
  filePath?: string,
  line?: number,
  host?: string,
): { command: string; args: string[] } {
  const absFile = filePath ? path.resolve(worktreePath, filePath) : undefined;
  if (host) {
    if (ide !== 'zed') throw new Error('A file on another machine opens only in Zed, which reaches it over ssh');
    const target = (absFile ?? worktreePath).split('/').map(encodeURIComponent).join('/');
    return { command: 'zed', args: [`ssh://${host}${target}${absFile && line ? `:${line}` : ''}`] };
  }

  const args = [worktreePath];
  if (absFile) {
    if (ide === 'idea') {
      if (line) args.push('--line', String(line));
      args.push(absFile);
    } else if (line) {
      // VS Code (--goto file:line) and Zed (file:line) both use file:line syntax
      args.push(...(ide === 'zed' ? [] : ['--goto']), `${absFile}:${line}`);
    } else {
      args.push(absFile);
    }
  }
  return { command: ide, args };
}

export function openInIde(
  worktreePath: string,
  ide?: Ide,
  filePath?: string,
  line?: number,
  host?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { command, args } = ideCommand(ide ?? loadConfig().ide, worktreePath, filePath, line, host);
    execFile(command, args, (error) => {
      if (error) {
        reject(new Error(`Failed to open ${worktreePath} in ${command}: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}
