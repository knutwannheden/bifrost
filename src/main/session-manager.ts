import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

/**
 * Claude positions each word with its own `\e[<n>G`, so neither spaces nor
 * multi-word phrases survive as literal substrings of the raw stream.
 */
function normalizeOutput(data: string): string {
  return (
    data
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC is the input being stripped
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase()
  );
}

interface ReadyGate {
  promise: Promise<void>;
  resolve: () => void;
  ready: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}
// A freshly spawned PTY accepts writes seconds before Claude's TUI reads them,
// so callers that inject input need a readiness signal rather than liveness.
// Readiness is quiescence — output started, then stopped — because every
// on-screen string Claude draws is subject to change between releases.
const sessionReady = new Map<string, ReadyGate>();
const READY_QUIET_MS = 1_000;
const TRUST_SCAN_LIMIT = 32 * 1024;

function createReadyGate(sessionId: string): void {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  sessionReady.set(sessionId, { promise, resolve, ready: false, timer: null });
}

/** Restart the quiet-period countdown; the last output before silence wins. */
function noteSessionOutput(sessionId: string): void {
  const gate = sessionReady.get(sessionId);
  if (!gate || gate.ready) return;
  if (gate.timer) clearTimeout(gate.timer);
  gate.timer = setTimeout(() => {
    gate.ready = true;
    gate.timer = null;
    gate.resolve();
  }, READY_QUIET_MS);
}

/** Release waiters on a session that died before its TUI came up. */
function disposeReadyGate(sessionId: string): void {
  const gate = sessionReady.get(sessionId);
  if (gate?.timer) clearTimeout(gate.timer);
  gate?.resolve();
  sessionReady.delete(sessionId);
}

function collectSpawnDiagnostics(
  command: string,
  cwd: string,
  env: Record<string, string>,
  err?: unknown,
): Record<string, unknown> {
  const diag: Record<string, unknown> = {};

  // Extract all properties from the error (node-pty may set errno/code)
  if (err instanceof Error) {
    diag.errorMessage = err.message;
    diag.errorCode = (err as NodeJS.ErrnoException).code;
    diag.errorErrno = (err as NodeJS.ErrnoException).errno;
    diag.errorSyscall = (err as NodeJS.ErrnoException).syscall;
    // Capture any non-standard properties node-pty may attach
    for (const key of Object.getOwnPropertyNames(err)) {
      if (!['message', 'stack', 'name', 'code', 'errno', 'syscall'].includes(key)) {
        diag[`error_${key}`] = (err as unknown as Record<string, unknown>)[key];
      }
    }
  }

  // Uptime since Bifrost started (rough proxy for idle time)
  diag.processUptimeS = Math.round(process.uptime());
  diag.memoryMB = Math.round(process.memoryUsage().rss / 1024 / 1024);

  // Can we resolve the command on PATH?
  try {
    diag.whichCommand = execFileSync('which', [command], { timeout: 3000, env }).toString().trim();
  } catch {
    diag.whichCommand = null;
  }

  // FD limit vs open count — EMFILE is a common posix_spawnp failure
  try {
    diag.openFds = fs.readdirSync('/dev/fd').length;
  } catch {
    // /dev/fd not available
  }
  try {
    const ulimitOut = execFileSync('sh', ['-c', 'ulimit -n'], { timeout: 3000 }).toString().trim();
    diag.fdLimit = ulimitOut;
  } catch {
    // ignore
  }

  // Process count limit — EAGAIN if too many processes
  try {
    const ulimitU = execFileSync('sh', ['-c', 'ulimit -u'], { timeout: 3000 }).toString().trim();
    diag.processLimit = ulimitU;
  } catch {
    // ignore
  }
  try {
    const psCount = execFileSync('sh', ['-c', 'ps -u $(whoami) | wc -l'], { timeout: 3000 }).toString().trim();
    diag.userProcessCount = psCount;
  } catch {
    // ignore
  }

  // Active PTY sessions tracked by Bifrost
  diag.activeSessions = sessions.size;

  // PTY device exhaustion — macOS has a kernel limit (default 127)
  if (process.platform === 'darwin') {
    try {
      diag.ptyMax = execFileSync('sysctl', ['-n', 'kern.tty.ptmx_max'], { timeout: 3000 }).toString().trim();
    } catch {
      // ignore
    }
  }
  try {
    // Count PTY devices in use system-wide
    const ptyCount = execFileSync('sh', ['-c', 'ls /dev/ttys* 2>/dev/null | wc -l'], { timeout: 3000 })
      .toString()
      .trim();
    diag.ptyDevicesInUse = ptyCount;
  } catch {
    // ignore
  }

  // Can we open /dev/ptmx directly? Distinguishes PTY allocation failure from exec failure.
  try {
    const ptmxFd = fs.openSync('/dev/ptmx', 'r');
    fs.closeSync(ptmxFd);
    diag.ptmxOpenOk = true;
  } catch (e) {
    diag.ptmxOpenOk = false;
    diag.ptmxOpenError = e instanceof Error ? e.message : String(e);
  }

  // Can we spawn a basic child_process (no PTY)? Isolates posix_spawnp from PTY.
  try {
    execFileSync('/bin/echo', ['ok'], { timeout: 3000 });
    diag.execProbeOk = true;
  } catch (e) {
    diag.execProbeOk = false;
    diag.execProbeError = e instanceof Error ? e.message : String(e);
  }

  // Can we open a PTY at all? (quick test via posix_openpt equivalent)
  try {
    const probe = pty.spawn('/bin/echo', ['ok'], { name: 'xterm-256color', cols: 10, rows: 1, cwd: '/tmp' });
    probe.kill();
    diag.ptyProbeOk = true;
  } catch (e) {
    diag.ptyProbeOk = false;
    diag.ptyProbeError = String(e);
    if (e instanceof Error) {
      diag.ptyProbeCode = (e as NodeJS.ErrnoException).code;
      diag.ptyProbeErrno = (e as NodeJS.ErrnoException).errno;
    }
  }

  // CWD permissions
  try {
    fs.accessSync(cwd, fs.constants.R_OK | fs.constants.X_OK);
    diag.cwdAccessible = true;
  } catch {
    diag.cwdAccessible = false;
  }

  // Environment size (large envs can cause posix_spawn failures)
  diag.envKeyCount = Object.keys(env).length;
  diag.envSize = Object.entries(env).reduce((n, [k, v]) => n + k.length + v.length + 2, 0);
  diag.PATH = env.PATH;

  return diag;
}

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
    const tmpFile = path.join(os.tmpdir(), `bifrost-prompt-${sessionId}-${randomUUID().slice(0, 8)}`);
    fs.writeFileSync(tmpFile, `${options.prompt}\n`);
    const cmdParts = [command, ...args.map(shellEscape)].join(' ');
    spawnCommand = 'sh';
    spawnArgs = ['-c', `cat ${shellEscape(tmpFile)} | ${cmdParts}; rm -f ${shellEscape(tmpFile)}`];
    console.log(`[session] Prompt piped for ${sessionId}: ${tmpFile} (${options.prompt.length} chars)`);
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
    const diag = collectSpawnDiagnostics(spawnCommand, cwd, env, err);
    console.error(
      `[session] pty.spawn failed for ${sessionId}: cmd=${spawnCommand}, cwd=${cwd} (exists=${cwdExists}), openSessions=${openSessions}`,
      err,
    );
    console.error('[session] diagnostics:', JSON.stringify(diag, null, 2));
    throw err;
  }

  sessions.set(sessionId, shell);
  sessionBuffers.set(sessionId, '');
  createReadyGate(sessionId);

  // Auto-accept workspace trust prompt for Bifrost-managed Claude sessions.
  // Worktree directories are subdirectories of repos the user already added,
  // but Claude Code treats each unique CWD as a separate project needing trust.
  let trustHandled = !options?.autoTrust;

  shell.onData((data: string) => {
    // Accumulate output so the renderer can replay on connect
    const buf = (sessionBuffers.get(sessionId) ?? '') + data;
    sessionBuffers.set(sessionId, buf.length > MAX_BUFFER ? buf.slice(-MAX_BUFFER) : buf);

    noteSessionOutput(sessionId);

    // The trust prompt only appears during startup, which bounds this scan to
    // a small buffer — normalizing every chunk of a long session would not.
    if (!trustHandled) {
      if (buf.length > TRUST_SCAN_LIMIT) {
        trustHandled = true;
      } else if (normalizeOutput(buf).includes('yesitrustthisfolder')) {
        trustHandled = true;
        shell.write('\r');
      }
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
    disposeReadyGate(sessionId);
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
    name?: string;
    apiPort?: number;
    permissionMode?: string;
    agentTeams?: boolean;
    context?: string;
    prompt?: string;
    onResumeFailed?: () => void;
  },
): void {
  const buildArgs = (resume: boolean): string[] => {
    // Its consent prompt blocks startup until answered, which strands sessions
    // that are driven by an agent rather than watched in a tab.
    const a: string[] = ['--no-chrome'];
    if (resume && options?.resumeSessionId) a.push('--resume', options.resumeSessionId);
    if (options?.name) a.push('--name', options.name);
    if (options?.permissionMode === 'auto-mode') a.push('--enable-auto-mode');
    else if (options?.permissionMode === 'sandbox')
      a.push('--settings', JSON.stringify({ sandbox: { enabled: true } }));
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

/** Returns false when no live session holds the id, so callers can report the miss. */
export function writeToSession(sessionId: string, data: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;
  session.write(data);
  return true;
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Resolves true once the session's TUI accepts input, false on timeout or exit. */
export function waitForSessionReady(sessionId: string, timeoutMs = 20_000): Promise<boolean> {
  const gate = sessionReady.get(sessionId);
  if (!gate) return Promise.resolve(false);
  if (gate.ready) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    gate.promise.then(() => {
      clearTimeout(timer);
      resolve(gate.ready);
    });
  });
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
    disposeReadyGate(sessionId);
  }
}

export function killAllSessions(): void {
  for (const [id, session] of sessions) {
    session.kill('SIGTERM');
    sessions.delete(id);
    sessionBuffers.delete(id);
    disposeReadyGate(id);
  }
}
