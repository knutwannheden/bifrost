import fs from 'node:fs';
import path from 'node:path';
import { claudeConfigDirAt, claudeConfigRelative } from './claude-paths.ts';
import { trustDirectory } from './claude-trust.ts';

/** POSIX single quoting, which `sh` reads back verbatim whatever the value holds. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A tmux server of Bifrost's own, so its settings and sessions stay apart from the user's. */
export const TMUX_SOCKET = 'bifrost';

/**
 * The settings Bifrost's tmux server starts with. Its clients attach in
 * control mode, so tmux draws nothing for them.
 */
const TMUX_CONF = [
  'set -g history-limit 50000',
  'set -g window-size latest',
  // The tab reads the pane's bytes directly, so programs there write for xterm.js.
  'set -g default-terminal xterm-256color',
];

/** The configuration Bifrost's tmux server starts with, on every machine. */
export function tmuxConf(): string {
  return `${TMUX_CONF.join('\n')}\n`;
}

/** A task's session files, relative to the home directory. */
export function sessionDir(taskId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(taskId)) throw new Error(`Unsafe task id: ${taskId}`);
  return `.bifrost/sessions/${taskId}`;
}

export interface SessionSpec {
  home: string;
  taskId: string;
  worktreePath: string;
  /** The Claude session to resume, and to start under while it has no transcript. */
  sessionId: string;
  claudeArgs: string[];
  env: Record<string, string>;
  /** Sent as the first message of a session that has no transcript yet. */
  prompt?: string;
}

/**
 * The files in a task's session directory, by name, each written with a
 * newline after it. run.sh resumes the transcript when there is one, and
 * otherwise starts the session with its prompt.
 */
/** The line that gives a script on another machine the config dir Bifrost runs with, or Claude's default. */
export function configDirScript(): string {
  const relative = claudeConfigRelative();
  return relative ? `export CLAUDE_CONFIG_DIR="$HOME"/${shQuote(relative)}` : 'unset CLAUDE_CONFIG_DIR';
}

export function sessionFiles(spec: SessionSpec): Record<string, string> {
  const dir = `${spec.home}/${sessionDir(spec.taskId)}`;
  const exports = Object.entries(spec.env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe variable name: ${name}`);
    return `export ${name}=${shQuote(value)}`;
  });
  const configDir = claudeConfigDirAt(spec.home);
  const run = [
    // Set or cleared here, since the tmux server keeps whatever environment it started with.
    configDir ? `export CLAUDE_CONFIG_DIR=${shQuote(configDir)}` : 'unset CLAUDE_CONFIG_DIR',
    ...exports,
    // Claude shows links in a terminal it recognises and takes its colour depth from COLORTERM.
    // Inside tmux it sees neither, so the pane claims a terminal Claude knows.
    // FORCE_HYPERLINK would also reach the tools Claude runs, and it overrides their check for a terminal.
    'export TERM_PROGRAM=ghostty COLORTERM=truecolor',
    `d=${shQuote(dir)}`,
    // Tools such as headroom sit in ~/.local/bin, which only a login shell puts on PATH.
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd ${shQuote(spec.worktreePath)} || exit 1`,
    // A session that outlives Bifrost keeps this name while its task may be renamed.
    `printf '%s\\n' "$BIFROST_SESSION_NAME" > "$d/started-name"`,
    'sid=$(cat "$d/session-id")',
    `set -- ${spec.claudeArgs.map(shQuote).join(' ')}`,
    // Claude files the transcript under a directory named for the cwd, so it is found by session id alone.
    `if ls "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$sid".jsonl >/dev/null 2>&1; then`,
    '  rm -f "$d/prompt"',
    '  exec claude "$@" --resume "$sid"',
    'fi',
    // The prompt is moved aside as it is sent, so a later start under a new session id does not send it again.
    'if [ -f "$d/prompt" ]; then',
    '  mv "$d/prompt" "$d/prompt.sent"',
    '  cat "$d/prompt.sent" | claude "$@" --session-id "$sid"',
    '  exit',
    'fi',
    'exec claude "$@" --session-id "$sid"',
  ].join('\n');
  return {
    'session-id': spec.sessionId,
    ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
    'run.sh': run,
  };
}

/**
 * The arguments that attach a tmux control client to the task's session,
 * starting it from run.sh when it is missing. base is Bifrost's directory.
 * Every argument is safe for a login shell to read unquoted when base is.
 */
/** A client that ignores its size leaves the window's size to the others, as one with no screen of its own should. */
export function controlArgs(
  base: string,
  taskId: string,
  cols: number,
  rows: number,
  options: { ignoreSize?: boolean } = {},
): string[] {
  const dir = `${base}/sessions/${path.basename(sessionDir(taskId))}`;
  return [
    ...['-u', '-L', TMUX_SOCKET, '-f', `${base}/tmux.conf`, '-C'],
    ...['new-session', '-A', ...(options.ignoreSize ? ['-f', 'ignore-size'] : [])],
    ...['-s', taskId, '-x', `${cols}`, '-y', `${rows}`],
    ...['sh', `${dir}/run.sh`],
  ];
}

/** Writes Bifrost's tmux configuration and the task's session files under this machine's home. */
export function writeLocalSession(spec: SessionSpec): void {
  const dir = path.join(spec.home, sessionDir(spec.taskId));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(spec.home, '.bifrost', 'tmux.conf'), tmuxConf());
  for (const [name, content] of Object.entries(sessionFiles(spec))) {
    fs.writeFileSync(path.join(dir, name), `${content}\n`);
  }
  trustDirectory(spec.worktreePath);
}

/** sessionIdScript, for a session on this machine. */
export function writeLocalSessionId(home: string, taskId: string, sessionId: string): void {
  const dir = path.join(home, sessionDir(taskId));
  if (fs.existsSync(dir)) fs.writeFileSync(path.join(dir, 'session-id'), `${sessionId}\n`);
}

/** The name the task's session on this machine started under, as run.sh recorded it. */
export function startedName(home: string, taskId: string): string | undefined {
  try {
    return fs.readFileSync(path.join(home, sessionDir(taskId), 'started-name'), 'utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}
