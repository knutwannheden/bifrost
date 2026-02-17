import type { BrowserWindow } from 'electron';
import type { IPty } from 'node-pty';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

// tmux pane sessions: virtual sessions backed by tmux pipe-pane + send-keys
interface TmuxPaneSession {
  tmuxSessionName: string;
  paneId: string;
  watcher: ReturnType<typeof setInterval>;
  outFile: string;
}
const tmuxPaneSessions = new Map<string, TmuxPaneSession>();
const tmuxPaneTmpDir = path.join(os.tmpdir(), 'bifrost-tmux');

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

export interface CreateSessionOptions {
  resume?: boolean;
  claudeSessionId?: string;
  taskId?: string;
  apiPort?: number;
  permissionMode?: string;
  agentTeams?: boolean;
}

function buildClaudeArgs(options?: CreateSessionOptions): string[] {
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
  return args;
}

function buildExtraEnv(options?: CreateSessionOptions): Record<string, string> {
  const extraEnv: Record<string, string> = {};
  if (options?.taskId) extraEnv.BIFROST_TASK_ID = options.taskId;
  if (options?.apiPort) extraEnv.BIFROST_API_PORT = String(options.apiPort);
  if (options?.agentTeams) extraEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  return extraEnv;
}

export function createSession(
  sessionId: string,
  cwd: string,
  mainWindow: BrowserWindow,
  options?: CreateSessionOptions,
): void {
  const args = buildClaudeArgs(options);
  const extraEnv = buildExtraEnv(options);
  spawnSession(sessionId, 'claude', args, cwd, mainWindow, { extraEnv });
}

/**
 * Spawn a Claude session inside a tmux session. The node-pty wraps the tmux
 * client, giving us the lead's terminal. Teammates spawned by Claude get their
 * own tmux panes that can be captured via createTmuxPaneSession().
 */
export function createTmuxSession(
  sessionId: string,
  cwd: string,
  mainWindow: BrowserWindow,
  options?: CreateSessionOptions,
): string {
  const tmuxName = `bifrost-${sessionId.slice(0, 8)}`;
  const claudeArgs = buildClaudeArgs(options);
  const extraEnv = buildExtraEnv(options);

  // Build env assignments for the tmux command
  const envArgs = Object.entries(extraEnv).map(([k, v]) => `${k}=${v}`);

  spawnSession(sessionId, 'tmux', [
    'new-session', '-s', tmuxName,
    '-x', '120', '-y', '30',
    '--', 'env', ...envArgs,
    'claude', ...claudeArgs,
  ], cwd, mainWindow);

  return tmuxName;
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
  // Route to tmux pane if this is a virtual pane session
  if (tmuxPaneSessions.has(sessionId)) {
    writeTmuxPane(sessionId, data);
    return;
  }
  const session = sessions.get(sessionId);
  if (session) {
    session.write(data);
  }
}

export function resizeSession(sessionId: string, cols: number, rows: number): void {
  if (tmuxPaneSessions.has(sessionId)) {
    resizeTmuxPane(sessionId, cols, rows);
    return;
  }
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

export function killSession(sessionId: string, tmuxSessionName?: string): void {
  // Clean up tmux pane session if applicable
  if (tmuxPaneSessions.has(sessionId)) {
    killTmuxPaneSession(sessionId);
    return;
  }

  const session = sessions.get(sessionId);
  if (session) {
    session.kill('SIGTERM');
    sessions.delete(sessionId);
    sessionBuffers.delete(sessionId);
  }

  // Kill the entire tmux session if this was a tmux-wrapped lead session
  if (tmuxSessionName) {
    try {
      execSync(`tmux kill-session -t ${JSON.stringify(tmuxSessionName)}`, { stdio: 'ignore' });
    } catch {
      // tmux session may already be gone
    }
  }
}

export function killAllSessions(): void {
  // Kill tmux pane sessions first
  for (const sessionId of tmuxPaneSessions.keys()) {
    killTmuxPaneSession(sessionId);
  }
  for (const [id, session] of sessions) {
    session.kill('SIGTERM');
    sessions.delete(id);
  }
}

// --- tmux pane session management ---

/**
 * Create a virtual session that captures output from a tmux pane via pipe-pane
 * and routes input via send-keys. This lets Bifrost display teammate terminals.
 */
export function createTmuxPaneSession(
  sessionId: string,
  tmuxSessionName: string,
  paneId: string,
  mainWindow: BrowserWindow,
): void {
  // Ensure tmp directory exists
  if (!fs.existsSync(tmuxPaneTmpDir)) {
    fs.mkdirSync(tmuxPaneTmpDir, { recursive: true });
  }

  // Capture initial scrollback
  let initial = '';
  try {
    initial = execSync(
      `tmux capture-pane -t "${tmuxSessionName}:${paneId}" -p -e -S -`,
      { encoding: 'utf-8', timeout: 5000 },
    );
  } catch {
    // Pane might not be ready yet
  }

  // Create output capture file
  const outFile = path.join(tmuxPaneTmpDir, `pane-${sessionId}.out`);
  fs.writeFileSync(outFile, '');

  // Start pipe-pane to stream output to file
  try {
    execSync(
      `tmux pipe-pane -t "${tmuxSessionName}:${paneId}" -o "cat >> ${outFile}"`,
      { timeout: 5000 },
    );
  } catch {
    // Best effort
  }

  // Watch file for new bytes and send to renderer
  let offset = 0;
  const watcher = setInterval(() => {
    try {
      const stat = fs.statSync(outFile);
      if (stat.size > offset) {
        const fd = fs.openSync(outFile, 'r');
        const buf = Buffer.alloc(stat.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        offset = stat.size;
        if (!mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.SESSION_DATA, sessionId, buf.toString());
        }
      }

      // Truncate file if it grows too large (> 1MB)
      if (stat.size > 1024 * 1024) {
        fs.truncateSync(outFile, 0);
        offset = 0;
      }
    } catch {
      // File may have been removed
    }
  }, 100);

  // Store initial content as session buffer for drain
  sessionBuffers.set(sessionId, initial);

  tmuxPaneSessions.set(sessionId, { tmuxSessionName, paneId, watcher, outFile });
}

function writeTmuxPane(sessionId: string, data: string): void {
  const pane = tmuxPaneSessions.get(sessionId);
  if (!pane) return;
  try {
    execSync(
      `tmux send-keys -t "${pane.tmuxSessionName}:${pane.paneId}" -l -- ${JSON.stringify(data)}`,
      { timeout: 5000 },
    );
  } catch {
    // Best effort
  }
}

export function killTmuxPaneSession(sessionId: string): void {
  const pane = tmuxPaneSessions.get(sessionId);
  if (!pane) return;
  clearInterval(pane.watcher);
  try {
    // Stop piping
    execSync(`tmux pipe-pane -t "${pane.tmuxSessionName}:${pane.paneId}"`, { stdio: 'ignore', timeout: 5000 });
  } catch {
    // tmux session may already be gone
  }
  try {
    fs.unlinkSync(pane.outFile);
  } catch {
    // File may already be removed
  }
  tmuxPaneSessions.delete(sessionId);
  sessionBuffers.delete(sessionId);
}

/** Resize a tmux pane to match the terminal dimensions. */
export function resizeTmuxPane(sessionId: string, cols: number, rows: number): void {
  const pane = tmuxPaneSessions.get(sessionId);
  if (!pane) return;
  try {
    execSync(
      `tmux resize-pane -t "${pane.tmuxSessionName}:${pane.paneId}" -x ${cols} -y ${rows}`,
      { stdio: 'ignore', timeout: 5000 },
    );
  } catch {
    // Best effort
  }
}

/** Check if a session ID is a tmux pane session. */
export function isTmuxPaneSession(sessionId: string): boolean {
  return tmuxPaneSessions.has(sessionId);
}
