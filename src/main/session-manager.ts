import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { IPty } from 'node-pty';
import { IPC_STREAM } from '../shared/ipc-channels.ts';
import type { RemoteHost } from './remote-host.ts';
import { createMirror, disposeMirror, mirrorOutput, resizeMirror, snapshotMirror } from './session-mirror.ts';
import { TmuxControl } from './tmux-control.ts';
import { controlArgs, startedName, TMUX_SOCKET } from './tmux-session.ts';

// node-pty is externalized from the Vite bundle, so it is required at run time, and only by dev shells.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadPty = (): typeof import('node-pty') => require('node-pty');

/**
 * Marks of the Claude Code session Bifrost itself may have been launched from.
 * A session that inherits them refuses to start, or starts as a child of that
 * one and writes no transcript — which the metrics, the token chart, title
 * generation and the sidebar's recency all read. Deliberate configuration such
 * as CLAUDE_CODE_MAX_OUTPUT_TOKENS is left alone.
 */
export const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_TMPDIR',
];

// Past any session's age or size, so the resume-summary offer never triggers.
const NEVER_STALE_MINUTES = 100 * 365 * 24 * 60;
const NEVER_LARGE_TOKENS = 1_000_000_000;

/** A session's terminal: a tmux control client for a Claude session, or a node-pty child for a dev shell. */
interface SessionStream {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Stops reading the session. A session in tmux runs on. */
  detach(): void;
  /** Ends the session and what runs in it. */
  kill(): void;
}

const sessions = new Map<string, SessionStream>();
/** Settles once a session joined in tmux has its screen in the mirror. */
const streamReady = new Map<string, Promise<void>>();
/**
 * The name each live session was started under. Claude Code's cross-session
 * addressing is by session name, and a session keeps the name its task had
 * when it started, so a task renamed since is addressed by its former one.
 */
const sessionNames = new Map<string, string>();

/** How a live session is addressed from another session, or undefined if it has none. */
export function getSessionName(sessionId: string): string | undefined {
  return sessionNames.get(sessionId);
}

function send(mainWindow: BrowserWindow, sessionId: string, data: string, isReplay: boolean): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.SESSION_DATA, sessionId, data, isReplay);
  }
}

// Claude's startup banners are the only thing scanned as raw text, so this is
// held separately from the mirror and stops growing once startup is over.
const startupBuffers = new Map<string, string>();
const MAX_STARTUP_BUFFER = 256 * 1024;

// Every task terminal shares one layout, so the last size any of them reported
// is the best guess for a session nobody has opened yet.
let lastKnownGeometry = { cols: 120, rows: 30 };
// Sessions spawned at a size of their own — the dev shell's short pane, say —
// do not speak for the sessions that take the default.
const fixedGeometry = new Set<string>();

// The size each session's terminal last asked for. An attach takes a moment to
// snapshot, and a resize landing in that window is the newer intent.
const desiredGeometry = new Map<string, { cols: number; rows: number }>();

function noteGeometry(sessionId: string, cols: number, rows: number): void {
  desiredGeometry.set(sessionId, { cols, rows });
  if (!fixedGeometry.has(sessionId)) lastKnownGeometry = { cols, rows };
}

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
  /** Stopped on the workspace trust prompt, which is quiet without being ready for a prompt. */
  awaitingTrust: boolean;
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
  sessionReady.set(sessionId, { promise, resolve, ready: false, timer: null, awaitingTrust: false });
}

/** Restart the quiet-period countdown; the last output before silence wins. */
/** Last PTY write per session: Claude animates while it works, so silence is telling. */
const lastOutputAt = new Map<string, number>();

export function sessionOutputAt(sessionId: string): number | undefined {
  return lastOutputAt.get(sessionId);
}

function noteSessionOutput(sessionId: string): void {
  lastOutputAt.set(sessionId, Date.now());
  const gate = sessionReady.get(sessionId);
  if (!gate || gate.ready || gate.awaitingTrust) return;
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
    const probe = loadPty().spawn('/bin/echo', ['ok'], { name: 'xterm-256color', cols: 10, rows: 1, cwd: '/tmp' });
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

function spawnSession(
  sessionId: string,
  command: string,
  args: string[],
  cwd: string,
  mainWindow: BrowserWindow,
  options?: {
    cols?: number;
    rows?: number;
    extraEnv?: Record<string, string>;
  },
): void {
  const env = { ...process.env } as Record<string, string>;
  for (const name of INHERITED_SESSION_VARS) delete env[name];

  if (options?.extraEnv) {
    Object.assign(env, options.extraEnv);
  }

  let shell: IPty;
  try {
    shell = loadPty().spawn(command, args, {
      name: 'xterm-256color',
      cols: options?.cols ?? lastKnownGeometry.cols,
      rows: options?.rows ?? lastKnownGeometry.rows,
      cwd,
      env,
    });
  } catch (err) {
    const cwdExists = fs.existsSync(cwd);
    const openSessions = sessions.size;
    const diag = collectSpawnDiagnostics(command, cwd, env, err);
    console.error(
      `[session] pty.spawn failed for ${sessionId}: cmd=${command}, cwd=${cwd} (exists=${cwdExists}), openSessions=${openSessions}`,
      err,
    );
    console.error('[session] diagnostics:', JSON.stringify(diag, null, 2));
    throw err;
  }

  const stream: SessionStream = {
    write: (data) => shell.write(data),
    resize: (cols, rows) => shell.resize(cols, rows),
    detach: () => shell.kill('SIGTERM'),
    kill: () => shell.kill('SIGTERM'),
  };
  register(sessionId, stream, options?.cols ?? lastKnownGeometry.cols, options?.rows ?? lastKnownGeometry.rows);
  if (options?.cols !== undefined || options?.rows !== undefined) fixedGeometry.add(sessionId);
  const output = outputHandler(sessionId, mainWindow, false, cwd);

  shell.onData((data: string) => {
    if (sessions.get(sessionId) === stream) output(data, true);
  });

  shell.onExit(({ exitCode }: { exitCode: number }) => {
    if (sessions.get(sessionId) === stream) ended(sessionId, mainWindow, exitCode);
  });
}

/**
 * Makes stream the session's only one. A stream it replaces stops being read,
 * since two streams of one session would each forward its output.
 */
function register(sessionId: string, stream: SessionStream, cols: number, rows: number): void {
  const previous = sessions.get(sessionId);
  if (previous) {
    sessions.delete(sessionId);
    previous.detach();
    disposeMirror(sessionId);
    disposeReadyGate(sessionId);
  }
  sessions.set(sessionId, stream);
  startupBuffers.set(sessionId, '');
  createMirror(sessionId, cols, rows);
  createReadyGate(sessionId);
}

/** Feeds a session's output to its mirror, its startup scan and readiness, and the window when toWindow. */
function outputHandler(
  sessionId: string,
  mainWindow: BrowserWindow,
  scanTrust: boolean,
  where: string,
): (data: string, toWindow: boolean) => void {
  let trustScanned = !scanTrust;
  return (data, toWindow) => {
    const forward = mirrorOutput(sessionId, data);

    const buf = (startupBuffers.get(sessionId) ?? '') + data;
    if (buf.length <= MAX_STARTUP_BUFFER) startupBuffers.set(sessionId, buf);

    noteSessionOutput(sessionId);

    // The trust prompt only appears during startup, which bounds this scan to
    // a small buffer — normalizing every chunk of a long session would not.
    // It is left for a person, since Enter on it picks "No, exit".
    if (!trustScanned) {
      if (buf.length > TRUST_SCAN_LIMIT) {
        trustScanned = true;
      } else if (normalizeOutput(buf).includes('yesitrustthisfolder')) {
        trustScanned = true;
        const gate = sessionReady.get(sessionId);
        if (gate && !gate.ready) {
          if (gate.timer) clearTimeout(gate.timer);
          gate.timer = null;
          gate.awaitingTrust = true;
          gate.resolve();
        }
        console.warn(`[session] ${sessionId} is stopped on the workspace trust prompt for ${where}`);
      }
    }

    if (forward && toWindow) send(mainWindow, sessionId, data, false);
  };
}

/** Tears down a session whose program has ended, and tells the window. */
function ended(sessionId: string, mainWindow: BrowserWindow, exitCode: number): void {
  sessions.delete(sessionId);
  forgetSession(sessionId);
  disposeReadyGate(sessionId);
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.SESSION_EXIT, sessionId, exitCode);
  }
}

/** A server started from here keeps this environment, and every session it runs inherits it. */
function localTmuxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of INHERITED_SESSION_VARS) delete env[name];
  return env;
}

/** Runs a tmux command against Bifrost's server on this machine, answering whether it succeeded. */
function localTmux(args: string[]): boolean {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { env: localTmuxEnv(), stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a session in tmux through a control client. Its replay fills the
 * mirror without reaching the window, which gets it from attachSession.
 */
function attachTmux(
  sessionId: string,
  mainWindow: BrowserWindow,
  start: (size: { cols: number; rows: number }) => TmuxControl,
  end: (control: TmuxControl) => void,
  options: {
    /** The window still shows the session from before, so the replay replaces it. */
    redraw?: boolean;
    /** Answers whether it has taken the exit over, such as to reconnect. */
    onExit?: (code: number | null) => boolean;
  } = {},
): void {
  const size = desiredGeometry.get(sessionId) ?? lastKnownGeometry;
  const control = start(size);
  const stream: SessionStream = {
    write: (data) => control.write(data),
    resize: (cols, rows) => control.resize(cols, rows),
    detach: () => control.detach(),
    kill: () => end(control),
  };
  register(sessionId, stream, size.cols, size.rows);
  const current = () => sessions.get(sessionId) === stream;
  const output = outputHandler(sessionId, mainWindow, true, sessionId);
  streamReady.set(
    sessionId,
    control.screen.then(
      (replay) => {
        if (current()) output(options.redraw ? `\x1bc${replay}` : replay, options.redraw === true);
      },
      () => {},
    ),
  );
  control.onOutput((data) => {
    if (current()) output(data, true);
  });
  control.onExit((code) => {
    if (current() && !options.onExit?.(code)) ended(sessionId, mainWindow, code === 0 ? 0 : (code ?? 1));
  });
}

/**
 * Joins the task's tmux session on this machine, or starts it from the files
 * writeLocalSession wrote. A session joined again keeps the name it started under.
 */
export function attachLocalSession(
  sessionId: string,
  mainWindow: BrowserWindow,
  options: { name?: string; taskId?: string; onExit?: () => void } = {},
): void {
  const home = os.homedir();
  const rejoining = localTmux(['has-session', '-t', `=${sessionId}`]);
  // A session joined again may be mid-turn.
  if (!rejoining) announceIdle(sessionId, mainWindow, options.taskId);
  attachTmux(
    sessionId,
    mainWindow,
    ({ cols, rows }) =>
      TmuxControl.start(
        'tmux',
        controlArgs(path.join(home, '.bifrost'), sessionId, cols, rows),
        { cols, rows },
        localTmuxEnv(),
      ),
    // kill-session runs here, so the session is over by the time killSession returns.
    (control) => {
      localTmux(['kill-session', '-t', `=${sessionId}`]);
      control.detach();
    },
    {
      onExit: () => {
        options.onExit?.();
        return false;
      },
    },
  );
  const name = (rejoining ? startedName(home, sessionId) : undefined) ?? options.name;
  if (name) sessionNames.set(sessionId, name);
}

export interface ClaudeLaunchOptions {
  taskId?: string;
  name?: string;
  apiPort?: number;
  permissionMode?: string;
  agentTeams?: boolean;
  context?: string;
}

/** Claude's arguments for a task session, short of which session to resume. */
export function claudeArgs(options?: ClaudeLaunchOptions, settings: Record<string, unknown> = {}): string[] {
  // Its consent prompt blocks startup until answered, which strands sessions
  // that are driven by an agent rather than watched in a tab.
  const a: string[] = ['--no-chrome'];
  if (options?.name) a.push('--name', options.name);
  const merged = { ...settings };
  if (options?.permissionMode === 'auto-mode') a.push('--enable-auto-mode');
  else if (options?.permissionMode === 'sandbox') merged.sandbox = { enabled: true };
  else if (options?.permissionMode === 'skip-permissions') a.push('--dangerously-skip-permissions');
  if (Object.keys(merged).length > 0) a.push('--settings', JSON.stringify(merged));
  return a;
}

/** What a task session's environment adds to the one it inherits. */
export function claudeEnv(options?: ClaudeLaunchOptions): Record<string, string> {
  const e: Record<string, string> = {};
  // Resuming a stale, large session otherwise offers to summarize it first.
  // Claude only compacts when that offer is accepted, so putting the offer
  // out of reach is how a task resumes as-is. Both thresholds have to be
  // passed for it to appear. Both are raised in case that becomes either.
  e.CLAUDE_CODE_RESUME_THRESHOLD_MINUTES = String(NEVER_STALE_MINUTES);
  e.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = String(NEVER_LARGE_TOKENS);
  e.BIFROST_CONTEXT = options?.context ?? 'code';
  if (options?.taskId) e.BIFROST_TASK_ID = options.taskId;
  if (options?.name) e.BIFROST_SESSION_NAME = options.name;
  if (options?.apiPort) e.BIFROST_API_PORT = String(options.apiPort);
  if (options?.agentTeams) e.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
  return e;
}

/** A session comes up with nothing in flight, whatever Bifrost last heard about the one before it. */
function announceIdle(sessionId: string, mainWindow: BrowserWindow, taskId?: string): void {
  lastOutputAt.set(sessionId, Date.now());
  if (taskId && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, taskId, false);
  }
}

/** Delays between attempts to reattach a remote session whose connection dropped, about a minute in all. */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
/** A connection that held this long counts as recovered, and the next drop gets every attempt again. */
const RECONNECT_RESET_MS = 60_000;
/** Remote sessions between a dropped connection and the next attempt, with how to give the attempt up. */
const pendingReconnects = new Map<string, { timer: ReturnType<typeof setTimeout>; abandon: () => void }>();

/**
 * A task session on another machine, read through a tmux control client over
 * ssh, so Claude keeps working when the connection or Bifrost goes away. ssh
 * exits 255 when the connection fails, and only that is retried. The remote
 * side ending the session exits with anything else.
 */
export function createRemoteSession(
  sessionId: string,
  host: RemoteHost,
  mainWindow: BrowserWindow,
  options: { name?: string; onGiveUp?: () => void },
): void {
  announceIdle(sessionId, mainWindow, sessionId);
  host.hold(sessionId);
  // Brings up the link that carries the API to the machine.
  host.connect().catch((err) => console.warn(`[session] ${host.machine.name}: ${(err as Error).message}`));

  let attempt = 0;
  let startedAt = 0;

  const lost = (code: number | null): boolean => {
    if (code !== 255) {
      host.release(sessionId);
      return false;
    }
    if (Date.now() - startedAt > RECONNECT_RESET_MS) attempt = 0;
    const delay = RECONNECT_DELAYS_MS[attempt++];
    if (delay === undefined) {
      host.release(sessionId);
      options.onGiveUp?.();
      return false;
    }
    sessions.delete(sessionId);
    disposeMirror(sessionId);
    send(mainWindow, sessionId, `\r\n[Connection to ${host.machine.name} lost, reconnecting…]\r\n`, false);
    const timer = setTimeout(() => {
      pendingReconnects.delete(sessionId);
      connect(true);
    }, delay);
    pendingReconnects.set(sessionId, { timer, abandon: () => host.release(sessionId) });
    return true;
  };

  const connect = (redraw: boolean) => {
    startedAt = Date.now();
    attachTmux(
      sessionId,
      mainWindow,
      ({ cols, rows }) => {
        const { command, args } = host.controlCommand(sessionId, cols, rows);
        return TmuxControl.start(command, args, { cols, rows });
      },
      (control) => {
        host.release(sessionId);
        control.kill();
      },
      { redraw, onExit: lost },
    );
  };
  connect(false);
  if (options.name) sessionNames.set(sessionId, options.name);
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
  // Someone is answering the trust prompt, after which the session settles like any other.
  if (sessionReady.get(sessionId)?.awaitingTrust) createReadyGate(sessionId);
  session.write(data);
  return true;
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

export function sessionAwaitsTrust(sessionId: string): boolean {
  return sessionReady.get(sessionId)?.awaitingTrust === true;
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

function forgetSession(sessionId: string): void {
  sessionNames.delete(sessionId);
  streamReady.delete(sessionId);
  disposeMirror(sessionId);
  startupBuffers.delete(sessionId);
  fixedGeometry.delete(sessionId);
  desiredGeometry.delete(sessionId);
}

export function resizeSession(sessionId: string, cols: number, rows: number): void {
  noteGeometry(sessionId, cols, rows);
  resizeMirror(sessionId, cols, rows);
  sessions.get(sessionId)?.resize(cols, rows);
}

/**
 * Send a connecting terminal the session's screen, then match the PTY to it.
 * The snapshot travels on the data stream so it stays ordered with live output.
 */
export async function attachSession(
  sessionId: string,
  mainWindow: BrowserWindow,
  cols: number,
  rows: number,
): Promise<boolean> {
  noteGeometry(sessionId, cols, rows);
  await streamReady.get(sessionId);
  const snapshot = await snapshotMirror(sessionId, cols, rows);
  if (!snapshot) return false;

  send(mainWindow, sessionId, snapshot.replay, true);
  for (const data of snapshot.held) send(mainWindow, sessionId, data, false);

  const desired = desiredGeometry.get(sessionId) ?? { cols, rows };
  sessions.get(sessionId)?.resize(desired.cols, desired.rows);
  return true;
}

function abandonReconnect(sessionId: string): void {
  const pending = pendingReconnects.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingReconnects.delete(sessionId);
  pending.abandon();
  forgetSession(sessionId);
}

/** Ends the session, including a session in tmux on this machine that no stream reads. */
export function killSession(sessionId: string): void {
  abandonReconnect(sessionId);
  const session = sessions.get(sessionId);
  if (!session) {
    localTmux(['kill-session', '-t', `=${sessionId}`]);
    return;
  }
  sessions.delete(sessionId);
  session.kill();
  lastOutputAt.delete(sessionId);
  forgetSession(sessionId);
  disposeReadyGate(sessionId);
}

/** Stops reading every session. Sessions in tmux run on, and dev shells end. */
export function detachAllSessions(): void {
  for (const id of [...pendingReconnects.keys()]) abandonReconnect(id);
  for (const [id, session] of [...sessions]) {
    sessions.delete(id);
    session.detach();
    forgetSession(id);
    disposeReadyGate(id);
  }
}
