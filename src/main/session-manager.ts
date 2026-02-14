import type { BrowserWindow } from 'electron';
import type { IPty } from 'node-pty';
import { IPC_STREAM } from '../shared/ipc-channels';

// Use require for node-pty because it's externalized from Vite bundling
const pty = require('node-pty');

const sessions = new Map<string, IPty>();

function spawnSession(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  mainWindow: BrowserWindow,
  options?: { cols?: number; rows?: number },
): void {
  const env = { ...process.env } as Record<string, string>;
  // Remove CLAUDECODE so claude CLI doesn't refuse to start
  // when Bifrost itself was launched from a Claude Code session
  delete env.CLAUDECODE;

  const shell = pty.spawn(command, args, {
    name: 'xterm-256color',
    cols: options?.cols ?? 120,
    rows: options?.rows ?? 30,
    cwd,
    env,
  });

  sessions.set(sessionId, shell);

  shell.onData((data: string) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_STREAM.SESSION_DATA, sessionId, data);
    }
  });

  shell.onExit(({ exitCode }: { exitCode: number }) => {
    sessions.delete(sessionId);
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_STREAM.SESSION_EXIT, sessionId, exitCode);
    }
  });
}

export function createSession(
  sessionId: string,
  cwd: string,
  mainWindow: BrowserWindow,
  options?: { resume?: boolean },
): void {
  const args = options?.resume ? ['--continue'] : [];
  spawnSession(sessionId, 'claude', args, cwd, mainWindow);
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

export function killSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.kill();
    sessions.delete(sessionId);
  }
}

export function killAllSessions(): void {
  for (const [id, session] of sessions) {
    session.kill();
    sessions.delete(id);
  }
}
