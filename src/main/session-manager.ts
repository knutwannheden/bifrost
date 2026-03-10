import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { IPty } from 'node-pty';
import { IPC_STREAM } from '../shared/ipc-channels';

// Use require for node-pty because it's externalized from Vite bundling
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pty = require('node-pty');

const sessions = new Map<string, IPty>();
// Buffer recent output per session so the renderer can replay it on connect.
// This handles the startup race where the PTY produces data before the
// renderer's terminal listener is registered.
const sessionBuffers = new Map<string, string>();
const MAX_BUFFER = 256 * 1024; // 256 KB per session

function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

export function spawnSession(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  mainWindow: BrowserWindow,
  options?: {
    cols?: number;
    rows?: number;
    extraEnv?: Record<string, string>;
    autoTrust?: boolean;
    prompt?: string;
    onBeforeExit?: (buffer: string, exitCode: number) => boolean;
  },
): void {
  const env = { ...process.env } as Record<string, string>;
  // Remove CLAUDECODE so claude CLI doesn't refuse to start
  // when Bifrost itself was launched from a Claude Code session
  delete env.CLAUDECODE;

  if (options?.extraEnv) {
    Object.assign(env, options.extraEnv);
  }

  let spawnCommand: string;
  let spawnArgs: string[];

  if (options?.prompt) {
    // Pipe the prompt via stdin so Claude reads it as the initial message.
    // This avoids terminal paste-detection issues that occur when writing
    // multi-line text to the PTY after the welcome banner.
    const tmpFile = path.join(os.tmpdir(), `bifrost-prompt-${sessionId}`);
    fs.writeFileSync(tmpFile, `${options.prompt}\n`);
    const cmdParts = [command, ...args.map(shellEscape)].join(' ');
    spawnCommand = 'sh';
    spawnArgs = ['-c', `cat ${shellEscape(tmpFile)} | ${cmdParts}; rm -f ${shellEscape(tmpFile)}`];
  } else {
    spawnCommand = command;
    spawnArgs = args;
  }

  let shell: IPty;
  try {
    shell = pty.spawn(spawnCommand, spawnArgs, {
      name: 'xterm-256color',
      cols: options?.cols ?? 120,
      rows: options?.rows ?? 30,
      cwd,
      env,
    });
  } catch (err) {
    const cwdExists = fs.existsSync(cwd);
    const openSessions = sessions.size;
    console.error(
      `[session] pty.spawn failed for ${sessionId}: cmd=${spawnCommand}, cwd=${cwd} (exists=${cwdExists}), openSessions=${openSessions}`,
      err,
    );
    throw err;
  }

  sessions.set(sessionId, shell);
  sessionBuffers.set(sessionId, '');

  // Auto-accept workspace trust prompt for Bifrost-managed Claude sessions.
  // Worktree directories are subdirectories of repos the user already added,
  // but Claude Code treats each unique CWD as a separate project needing trust.
  let trustHandled = !options?.autoTrust;

  shell.onData((data: string) => {
    // Accumulate output so the renderer can replay on connect
    const buf = (sessionBuffers.get(sessionId) ?? '') + data;
    sessionBuffers.set(sessionId, buf.length > MAX_BUFFER ? buf.slice(-MAX_BUFFER) : buf);

    if (!trustHandled && buf.includes('Yes, I trust this folder')) {
      trustHandled = true;
      shell.write('\r');
    }

    // Welcome banner without trust prompt means workspace is already trusted
    if (!trustHandled && buf.includes('╰')) {
      trustHandled = true;
    }

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_STREAM.SESSION_DATA, sessionId, data);
    }
  });

  shell.onExit(({ exitCode }: { exitCode: number }) => {
    const buffer = sessionBuffers.get(sessionId) ?? '';
    if (options?.onBeforeExit?.(buffer, exitCode)) {
      // Don't delete session/buffer or emit exit — caller already spawned a replacement
      return;
    }
    sessions.delete(sessionId);
    sessionBuffers.delete(sessionId);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_STREAM.SESSION_EXIT, sessionId, exitCode);
    }
  });
}

export function createSession(
  sessionId: string,
  cwd: string,
  mainWindow: BrowserWindow,
  options?: {
    resumeSessionId?: string;
    taskId?: string;
    apiPort?: number;
    permissionMode?: string;
    agentTeams?: boolean;
    context?: string;
    prompt?: string;
    onResumeFailed?: () => void;
  },
): void {
  const buildArgs = (resume: boolean): string[] => {
    const a: string[] = [];
    if (resume && options?.resumeSessionId) a.push('--resume', options.resumeSessionId);
    if (options?.permissionMode === 'sandbox') a.push('--settings', JSON.stringify({ sandbox: { enabled: true } }));
    else if (options?.permissionMode === 'skip-permissions') a.push('--dangerously-skip-permissions');
    return a;
  };

  const buildEnv = (): Record<string, string> => {
    const e: Record<string, string> = {};
    e.BIFROST_CONTEXT = options?.context ?? 'code';
    if (options?.taskId) e.BIFROST_TASK_ID = options.taskId;
    if (options?.apiPort) e.BIFROST_API_PORT = String(options.apiPort);
    if (options?.agentTeams) e.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    return e;
  };

  // When resuming, detect "No conversation found" and automatically retry without --resume
  const onBeforeExit = options?.resumeSessionId
    ? (buffer: string): boolean => {
        if (buffer.includes('No conversation found')) {
          console.log(`[session] Resume failed for ${sessionId}, restarting without --resume`);
          spawnSession(sessionId, 'claude', buildArgs(false), cwd, mainWindow, {
            extraEnv: buildEnv(),
            autoTrust: true,
          });
          options?.onResumeFailed?.();
          return true;
        }
        return false;
      }
    : undefined;

  const prompt = options?.prompt && !options.resumeSessionId ? options.prompt : undefined;
  spawnSession(sessionId, 'claude', buildArgs(true), cwd, mainWindow, {
    extraEnv: buildEnv(),
    autoTrust: true,
    prompt,
    onBeforeExit,
  });
}

function findShell(): string {
  for (const p of ['/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    if (fs.existsSync(p)) return p;
  }
  return '/bin/sh';
}

export function createShellSession(
  sessionId: string,
  cwd: string,
  mainWindow: BrowserWindow,
  options?: { taskId?: string },
): void {
  const shellPath = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : findShell());
  const extraEnv: Record<string, string> = {
    BIFROST_CONTEXT: 'dev',
    BIFROST_WORKTREE: cwd,
  };
  if (options?.taskId) extraEnv.BIFROST_TASK_ID = options.taskId;
  spawnSession(sessionId, shellPath, ['-l'], cwd, mainWindow, { rows: 15, extraEnv });
}

export function writeToSession(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.write(data);
  }
}

export function resizeSession(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.resize(cols, rows);
  }
}

/** Return buffered output and clear it (one-time replay for renderer connect). */
export function drainSessionBuffer(sessionId: string): string {
  const buf = sessionBuffers.get(sessionId) ?? '';
  sessionBuffers.set(sessionId, '');
  return buf;
}

export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.kill('SIGTERM');
    sessions.delete(sessionId);
    sessionBuffers.delete(sessionId);
  }
}

export function killAllSessions(): void {
  for (const [id, session] of sessions) {
    session.kill('SIGTERM');
    sessions.delete(id);
    sessionBuffers.delete(id);
  }
}
