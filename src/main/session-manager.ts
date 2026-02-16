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

function spawnSession(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  mainWindow: BrowserWindow,
  options?: { cols?: number; rows?: number; extraEnv?: Record<string, string> },
): void {
  const env = { ...process.env } as Record<string, string>;
  // Remove CLAUDECODE so claude CLI doesn't refuse to start
  // when Bifrost itself was launched from a Claude Code session
  delete env.CLAUDECODE;

  if (options?.extraEnv) {
    Object.assign(env, options.extraEnv);
  }

  const shell = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: options?.cols ?? 120,
    rows: options?.rows ?? 30,
    cwd,
    env,
  });

  sessions.set(sessionId, shell);
  sessionBuffers.set(sessionId, '');

  shell.onData((data: string) => {
    // Accumulate output so the renderer can replay on connect
    const buf = (sessionBuffers.get(sessionId) ?? '') + data;
    sessionBuffers.set(sessionId, buf.length > MAX_BUFFER ? buf.slice(-MAX_BUFFER) : buf);

    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_STREAM.SESSION_DATA, sessionId, data);
    }
  });

  shell.onExit(({ exitCode }: { exitCode: number }) => {
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
  options?: { resume?: boolean; claudeSessionId?: string; taskId?: string; apiPort?: number; permissionMode?: string; agentTeams?: boolean },
): void {
  const args: string[] = [];
  if (options?.claudeSessionId) {
    args.push('--resume', options.claudeSessionId);
  } else if (options?.resume) {
    args.push('--continue');
  }
  if (options?.permissionMode === 'sandbox') {
    args.push('--settings', JSON.stringify({ sandbox: { enabled: true } }));
  } else if (options?.permissionMode === 'skip-permissions') {
    args.push('--dangerously-skip-permissions');
  }
  const extraEnv: Record<string, string> = {};
  if (options?.taskId) extraEnv.BIFROST_TASK_ID = options.taskId;
  if (options?.apiPort) extraEnv.BIFROST_API_PORT = String(options.apiPort);
  if (options?.agentTeams) extraEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  spawnSession(sessionId, 'claude', args, cwd, mainWindow, { extraEnv });
}

export function createShellSession(
  sessionId: string,
  cwd: string,
  mainWindow: BrowserWindow,
): void {
  const shellPath = process.env.SHELL || '/bin/zsh';
  spawnSession(sessionId, shellPath, ['-l'], cwd, mainWindow, { rows: 15 });
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

/** Resize all PTY sessions to the given dimensions.
 *  Keeps background PTYs in sync when the window is resized. */
export function resizeAllSessions(cols: number, rows: number): void {
  for (const session of sessions.values()) {
    try {
      session.resize(cols, rows);
    } catch { /* ignore errors from exiting sessions */ }
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
  }
}
