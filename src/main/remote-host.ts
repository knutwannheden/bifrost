import { type ChildProcess, execFile as execFileCb, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Machine } from '../shared/types.ts';
import { TRUSTED_ENTRY } from './claude-trust.ts';
import { loadConfig } from './config.ts';
import { PLUGIN_DEPLOY_DIR, readPluginVersion } from './integration-installer.ts';
import { syncMachine } from './remote-sync.ts';

const execFile = promisify(execFileCb);

// Each script is handed to `sh -s` on the machine's stdin, so the remote login
// shell, whichever it is, never parses a quoted value.

/** POSIX single quoting, which `sh` reads back verbatim whatever the value holds. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Bifrost's directory on a machine, relative to the home directory `ssh` starts in. */
const REMOTE_DIR = '.bifrost';
/** A Bifrost install deletes `.bifrost/plugin` as a leftover, so the copy lives under another name. */
const REMOTE_PLUGIN_DIR = `${REMOTE_DIR}/claude-plugin`;
/** A tmux server of Bifrost's own, so its settings and sessions stay apart from the user's. */
const TMUX_SOCKET = 'bifrost';

/** Prefix keys and the status line would sit between the tab and Claude. */
const TMUX_CONF = [
  'set -g prefix None',
  'set -g prefix2 None',
  'set -g status off',
  'set -g mouse off',
  'set -g history-limit 50000',
  'set -s escape-time 0',
  'set -g focus-events on',
  'set -g set-titles on',
  "set -g set-titles-string '#T'",
  'set -g window-size latest',
  // Keeps tmux off the alternate screen, which has no scrollback.
  "set -ga terminal-overrides ',*:smcup@:rmcup@'",
  "set -as terminal-features ',*:RGB'",
];

function sessionDir(taskId: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(taskId)) throw new Error(`Unsafe task id: ${taskId}`);
  return `${REMOTE_DIR}/sessions/${taskId}`;
}

/**
 * Where a machine keeps a repo's clone, relative to its home directory. It is
 * the path the repo has here, so a path a prompt names holds there as well.
 */
export function remoteClonePath(repo: { path: string; githubPath?: string; name: string }): string {
  const relative = path.relative(os.homedir(), repo.path);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.split(path.sep).join('/');
  return `git/${repo.githubPath ?? repo.name}`;
}

/** A remote worktree sits in its clone's .worktrees directory, as a local one does. */
function cloneOf(worktreePath: string): string {
  const i = worktreePath.lastIndexOf('/.worktrees/');
  if (i < 0) throw new Error(`Not a Bifrost worktree: ${worktreePath}`);
  return worktreePath.slice(0, i);
}

/** The `KEY=value` lines a script prints, the last of each key winning. */
export function parseScriptOutput(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0 && /^[A-Z_]+$/.test(line.slice(0, eq))) values[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return values;
}

/**
 * The command a tab's `ssh` runs. The remote login shell parses it, so it holds
 * nothing that needs quoting, and the rest lives in the session's scripts.
 */
export function attachCommand(taskId: string): string {
  return `sh ${sessionDir(taskId)}/attach.sh`;
}

export interface RemoteSessionSpec {
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
 * Writes the scripts a task's session runs from. attach.sh joins the task's tmux
 * session or starts it, so a dropped connection, a Bifrost restart and a reboot
 * of the machine all come back through it. run.sh resumes the transcript when
 * there is one, and otherwise starts the session with its prompt.
 */
export function sessionSetupScript(spec: RemoteSessionSpec): string {
  const dir = `${spec.home}/${sessionDir(spec.taskId)}`;
  const exports = Object.entries(spec.env).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe variable name: ${name}`);
    return `export ${name}=${shQuote(value)}`;
  });
  const run = [
    ...exports,
    `d=${shQuote(dir)}`,
    // Tools such as headroom sit in ~/.local/bin, which only a login shell puts on PATH.
    'export PATH="$HOME/.local/bin:$PATH"',
    `cd ${shQuote(spec.worktreePath)} || exit 1`,
    'sid=$(cat "$d/session-id")',
    `set -- ${spec.claudeArgs.map(shQuote).join(' ')}`,
    // Claude files the transcript under a directory named for the cwd, so it is found by session id alone.
    'if ls "$HOME"/.claude/projects/*/"$sid".jsonl >/dev/null 2>&1; then',
    '  rm -f "$d/prompt"',
    '  exec claude "$@" --resume "$sid"',
    'fi',
    'if [ -f "$d/prompt" ]; then',
    '  cat "$d/prompt" | claude "$@" --session-id "$sid"',
    '  exit',
    'fi',
    'exec claude "$@" --session-id "$sid"',
  ].join('\n');
  const conf = shQuote(`${spec.home}/${REMOTE_DIR}/tmux.conf`);
  const attach =
    `exec tmux -u -L ${TMUX_SOCKET} -f ${conf} new-session -A -s ${shQuote(spec.taskId)} ` +
    `-c ${shQuote(spec.worktreePath)} sh ${shQuote(`${dir}/run.sh`)}`;
  return [
    'set -e',
    `python3 -c ${shQuote(TRUST_PY)} ${shQuote(spec.worktreePath)} ${shQuote(JSON.stringify(TRUSTED_ENTRY))} || true`,
    `d=${shQuote(dir)}`,
    'mkdir -p "$d"',
    `printf '%s\\n' ${shQuote(spec.sessionId)} > "$d/session-id"`,
    ...(spec.prompt !== undefined ? [`printf '%s\\n' ${shQuote(spec.prompt)} > "$d/prompt"`] : []),
    `printf '%s\\n' ${shQuote(run)} > "$d/run.sh"`,
    `printf '%s\\n' ${shQuote(attach)} > "$d/attach.sh"`,
  ].join('\n');
}

/** Points run.sh at the session a `/clear` started, so a later attach resumes that one. */
export function sessionIdScript(taskId: string, sessionId: string): string {
  return `printf '%s\\n' ${shQuote(sessionId)} > "$HOME"/${sessionDir(taskId)}/session-id`;
}

/** Ends the task's tmux session, and with it Claude. */
export function stopSessionScript(taskId: string): string {
  return `tmux -L ${TMUX_SOCKET} kill-session -t ${shQuote(`=${taskId}`)} 2>/dev/null || true`;
}

/**
 * Stops the session and deletes its files and the worktree, keeping the branch
 * as a local archive does. A detached HEAD has no branch to rebuild from, so
 * that worktree stays. Prints BRANCH.
 */
export function archiveScript(taskId: string, worktreePath: string): string {
  const clone = shQuote(cloneOf(worktreePath));
  const wt = shQuote(worktreePath);
  return [
    stopSessionScript(taskId),
    `rm -rf "$HOME"/${sessionDir(taskId)}`,
    `[ -d ${wt} ] || exit 0`,
    `branch=$(git -C ${wt} symbolic-ref --short HEAD 2>/dev/null) || exit 0`,
    `printf 'BRANCH=%s\\n' "$branch"`,
    `git -C ${clone} worktree remove --force ${wt}`,
    `git -C ${clone} worktree prune`,
  ].join('\n');
}

/** Builds an archived task's worktree back from its branch. */
export function restoreWorktreeScript(worktreePath: string, branch: string): string {
  const clone = shQuote(cloneOf(worktreePath));
  return [
    'set -e',
    `[ -d ${shQuote(worktreePath)} ] && exit 0`,
    `git -C ${clone} worktree prune`,
    `git -C ${clone} worktree add --quiet ${shQuote(worktreePath)} ${shQuote(branch)}`,
  ].join('\n');
}

/** Prints the worktree's uncommitted changes, which archiving would delete. */
export function statusScript(worktreePath: string): string {
  return `cd ${shQuote(worktreePath)} && git --no-optional-locks status --porcelain`;
}

export interface WorktreeSpec {
  /** Relative to the home directory. */
  clonePath: string;
  url: string;
  baseBranch: string;
  branchName: string;
  slug: string;
  gitName?: string;
  gitEmail?: string;
}

/**
 * Clones the repo on first use and fetches its base branch. Leaves clone, branch
 * and wt set to a branch name nobody holds and the worktree path for it.
 */
export function cloneLines(spec: WorktreeSpec): string[] {
  return [
    'set -e',
    'cd "$HOME"',
    `clone=${shQuote(spec.clonePath)}`,
    'if [ ! -d "$clone/.git" ]; then',
    '  mkdir -p "$(dirname "$clone")"',
    // Cloned beside its place and moved in, so an interrupted clone is never taken for a finished one.
    '  tmp="$clone.partial.$$"',
    '  rm -rf "$tmp"',
    `  git clone --quiet --no-checkout ${shQuote(spec.url)} "$tmp" </dev/null`,
    '  mv "$tmp" "$clone"',
    'fi',
    `git -C "$clone" fetch --quiet origin ${shQuote(spec.baseBranch)} </dev/null`,
    // A clone the user made there may carry an identity of its own, which stays.
    ...(spec.gitName
      ? [`git -C "$clone" config user.name >/dev/null || git -C "$clone" config user.name ${shQuote(spec.gitName)}`]
      : []),
    ...(spec.gitEmail
      ? [`git -C "$clone" config user.email >/dev/null || git -C "$clone" config user.email ${shQuote(spec.gitEmail)}`]
      : []),
    'exclude="$clone/.git/info/exclude"',
    'mkdir -p "$(dirname "$exclude")"',
    'grep -qxF \'/.worktrees/\' "$exclude" 2>/dev/null || printf \'/.worktrees/\\n\' >> "$exclude"',
    `desired=${shQuote(spec.branchName)}`,
    'branch="$desired"',
    'n=2',
    'while git -C "$clone" rev-parse --verify --quiet "refs/heads/$branch" >/dev/null; do',
    '  branch="$desired-$n"',
    '  n=$((n + 1))',
    'done',
    `wt="$HOME/$clone/.worktrees/"${shQuote(spec.slug)}`,
  ];
}

/** Forks a new branch's worktree from the freshly fetched base branch. Prints BRANCH, WORKTREE and BASE. */
export function worktreeScript(spec: WorktreeSpec): string {
  const base = shQuote(`origin/${spec.baseBranch}`);
  return [
    ...cloneLines(spec),
    `git -C "$clone" worktree add --quiet -b "$branch" "$wt" ${base}`,
    `git -C "$wt" branch --quiet --set-upstream-to ${base} "$branch" || true`,
    `printf 'BRANCH=%s\\nWORKTREE=%s\\nBASE=%s\\n' "$branch" "$wt" ${base}`,
  ].join('\n');
}

/**
 * Prints the worktree's changes as one unified diff. Tracked files are diffed
 * against HEAD, or against the merge base with baseRef when one is given. Each
 * untracked file of at most 1 MB follows as an addition.
 */
export function diffScript(worktreePath: string, baseRef?: string): string {
  return [
    `cd ${shQuote(worktreePath)} || exit 0`,
    'base=HEAD',
    ...(baseRef
      ? [
          // A merge in progress is measured from MERGE_HEAD, as resolveDiffBase does locally.
          'head=$(git rev-parse --verify --quiet MERGE_HEAD || echo HEAD)',
          `if mb=$(git merge-base ${shQuote(baseRef)} "$head" 2>/dev/null); then base=$mb; fi`,
        ]
      : []),
    'git --no-optional-locks diff "$base"',
    "git --no-optional-locks ls-files -z --others --exclude-standard | xargs -0 sh -c '" +
      'for f; do [ -f "$f" ] && [ $(($(wc -c < "$f"))) -le 1048576 ] && ' +
      'git --no-optional-locks diff --no-index -- /dev/null "$f"; done; exit 0\' sh',
  ].join('\n');
}

/** A python3 program that edits Claude Code's config, leaving one it cannot read alone. */
function editClaudeJson(body: string[]): string {
  return [
    'import json, os, sys',
    "path = os.path.join(os.environ.get('CLAUDE_CONFIG_DIR') or os.path.expanduser('~'), '.claude.json')",
    'try:',
    '    with open(path) as f:',
    '        config = json.load(f)',
    'except Exception:',
    '    sys.exit(0)',
    ...body,
    "tmp = '%s.bifrost-%d' % (path, os.getpid())",
    "with open(tmp, 'w') as f:",
    '    json.dump(config, f, indent=2)',
    'os.replace(tmp, path)',
  ].join('\n');
}

// Claude rewrites its config often, so each edit writes only when something is missing.
const TRUST_PY = editClaudeJson([
  'root = os.path.realpath(sys.argv[1])',
  "projects = config.setdefault('projects', {})",
  "if (projects.get(root) or {}).get('hasTrustDialogAccepted') is True:",
  '    sys.exit(0)',
  'entry = json.loads(sys.argv[2])',
  'entry.update(projects.get(root) or {})',
  "entry['hasTrustDialogAccepted'] = True",
  'projects[root] = entry',
]);

const ONBOARDING_PY = editClaudeJson([
  'seed = json.loads(sys.argv[1])',
  'if sys.argv[2]:',
  "    seed['lastOnboardingVersion'] = sys.argv[2]",
  'if all(key in config for key in seed):',
  '    sys.exit(0)',
  'for key, value in seed.items():',
  '    config.setdefault(key, value)',
]);

const PLUGIN_VERSION_PY = `import json; print(json.load(open('${REMOTE_PLUGIN_DIR}/.claude-plugin/plugin.json'))['version'])`;

/**
 * Readies a machine for task sessions and reports what it lacks. The hooks and
 * MCP server read the API port from .bifrost/api-port, so writing the forwarded
 * port there connects them to this Bifrost. Onboarding is marked done, with this
 * machine's theme, since its first screen would hold a session's prompt back.
 * Prints HOME, MISSING, LOGGED_IN and PLUGIN_VERSION.
 */
export function prepareScript(opts: { apiPort: number; theme?: string }): string {
  const onboarding = { hasCompletedOnboarding: true, ...(opts.theme ? { theme: opts.theme } : {}) };
  return [
    'set -e',
    'cd "$HOME"',
    `mkdir -p ${REMOTE_DIR}/sessions`,
    `printf '%s\\n' ${opts.apiPort} > ${REMOTE_DIR}/api-port`,
    'if infocmp tmux-256color >/dev/null 2>&1; then term=tmux-256color; else term=screen-256color; fi',
    `printf '%s\\n' ${TMUX_CONF.map(shQuote).join(' ')} "set -g default-terminal $term" > ${REMOTE_DIR}/tmux.conf`,
    `version=$(claude --version 2>/dev/null | cut -d' ' -f1)`,
    `python3 -c ${shQuote(ONBOARDING_PY)} ${shQuote(JSON.stringify(onboarding))} "$version" || true`,
    `printf 'HOME=%s\\n' "$HOME"`,
    'missing=',
    'for c in claude git tmux python3 curl; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done',
    `printf 'MISSING=%s\\n' "\${missing# }"`,
    `if claude auth status </dev/null 2>/dev/null | grep -q '"loggedIn": *true'; then echo LOGGED_IN=yes; else echo LOGGED_IN=no; fi`,
    `printf 'PLUGIN_VERSION=%s\\n' "$(python3 -c ${shQuote(PLUGIN_VERSION_PY)} 2>/dev/null || true)"`,
  ].join('\n');
}

/**
 * Settings a remote session starts with. On a machine where nobody ran Claude by
 * hand, its offer of the fullscreen renderer and its warning about skipped
 * permissions would each hold the prompt back. Remote Control follows this machine.
 */
export function remoteSessionSettings(permissionMode: string | undefined, remoteControl: boolean) {
  return {
    tui: 'default',
    ...(permissionMode === 'skip-permissions' ? { skipDangerousModePermissionPrompt: true } : {}),
    ...(remoteControl ? { remoteControlAtStartup: true } : {}),
  };
}

/** A value from Claude Code's settings on this machine, or else from its global config. */
export function localClaudeValue(key: string): unknown {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const files = [
    path.join(configDir ?? path.join(os.homedir(), '.claude'), 'settings.json'),
    path.join(configDir ?? os.homedir(), '.claude.json'),
  ];
  for (const file of files) {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf-8'))[key];
      if (value !== undefined) return value;
    } catch {
      /* absent or unreadable */
    }
  }
  return undefined;
}

export interface RemoteInfo {
  home: string;
  missing: string[];
  loggedIn: boolean;
  /** Where the Bifrost plugin sits there, or null when this machine has none to copy. */
  pluginDir: string | null;
}

const CONTROL_DIR = path.join(os.homedir(), '.bifrost', 'ssh');
/** Connecting may first start a stopped machine, which takes minutes. */
const CONNECT_TIMEOUT_MS = 5 * 60_000;
const EXEC_TIMEOUT_MS = 2 * 60_000;
const UPLOAD_TIMEOUT_MS = 15 * 60_000;
const RELINK_DELAY_MS = 10_000;
const IDLE_CLOSE_MS = 60_000;
const KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

/** A directory under Bifrost's own tools/, which exists when Bifrost runs from its checkout. */
function bifrostTool(name: string): string | undefined {
  // The main process is bundled into .vite/build, two levels below the checkout.
  if (typeof __dirname !== 'string') return undefined;
  const dir = path.resolve(__dirname, '..', '..', 'tools', name);
  return fs.existsSync(dir) ? dir : undefined;
}

function localApiPort(): number | null {
  try {
    return Number(fs.readFileSync(path.join(os.homedir(), '.bifrost', 'api-port'), 'utf-8').trim()) || null;
  } catch {
    return null;
  }
}

/**
 * One configured machine, reached over an SSH master connection. Every command
 * and tab shares it, and it forwards the Bifrost API to the machine. It stays
 * open while a tab holds it and closes a minute after the last one lets go.
 */
export class RemoteHost {
  readonly machine: Machine;
  private readonly controlPath: string;
  private master: ChildProcess | null = null;
  private info: RemoteInfo | null = null;
  private linking: Promise<RemoteInfo> | null = null;
  private readonly holders = new Set<string>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private relinkTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(machine: Machine) {
    this.machine = machine;
    this.controlPath = path.join(CONTROL_DIR, `${machine.name}.sock`);
  }

  /** Without a master to share, `ssh` connects on its own, so a tab never waits on the link. */
  private sshOptions(): string[] {
    return ['-S', this.controlPath, '-o', 'ControlMaster=no', ...KEEPALIVE];
  }

  /** The `ssh` arguments for a tab attached to the task's session. */
  ptyArgs(taskId: string): string[] {
    return [...this.sshOptions(), '-tt', this.machine.host, attachCommand(taskId)];
  }

  /** The machine, connected and prepared. */
  connect(): Promise<RemoteInfo> {
    if (this.info) return Promise.resolve(this.info);
    this.linking ??= this.link().finally(() => {
      this.linking = null;
    });
    return this.linking;
  }

  /** Throws naming what the machine lacks for running a task. */
  async connectReady(): Promise<RemoteInfo> {
    const info = await this.connect();
    const name = this.machine.name;
    if (info.missing.length) throw new Error(`${name} is missing ${info.missing.join(', ')}`);
    if (!info.loggedIn) throw new Error(`Claude is not logged in on ${name}: run claude there once and /login`);
    return info;
  }

  /** Runs a script on the machine with `sh -s`, answering its stdout. */
  async exec(script: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<string> {
    await this.connect();
    return this.run(script, timeoutMs);
  }

  hold(holder: string): void {
    this.holders.add(holder);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  release(holder: string): void {
    if (!this.holders.delete(holder) || this.holders.size > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.holders.size === 0) this.close();
    }, IDLE_CLOSE_MS);
  }

  /** Ends the master, including one a previous run of Bifrost left behind. */
  close(): void {
    for (const t of [this.idleTimer, this.relinkTimer]) if (t) clearTimeout(t);
    this.idleTimer = null;
    this.relinkTimer = null;
    this.info = null;
    try {
      execFileSync('ssh', ['-S', this.controlPath, '-O', 'exit', this.machine.host], {
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      /* no master running */
    }
    this.master?.kill();
    this.master = null;
  }

  private async link(): Promise<RemoteInfo> {
    const apiPort = localApiPort();
    if (!apiPort) throw new Error('The Bifrost API is not running');
    fs.mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
    if (!(await this.masterAlive())) {
      fs.rmSync(this.controlPath, { force: true });
      await this.startMaster();
    }
    const { stdout } = await execFile(
      'ssh',
      ['-S', this.controlPath, '-O', 'forward', '-R', `0:127.0.0.1:${apiPort}`, this.machine.host],
      { timeout: 30_000 },
    );
    const forwarded = Number(stdout.trim());
    if (!forwarded) throw new Error(`${this.machine.name} did not forward the Bifrost API`);

    const theme = localClaudeValue('theme');
    const prepare = prepareScript({ apiPort: forwarded, theme: typeof theme === 'string' ? theme : undefined });
    const out = parseScriptOutput(await this.run(prepare, EXEC_TIMEOUT_MS));
    if (!out.HOME) throw new Error(`${this.machine.name} could not be prepared`);
    const pluginDir = await this.syncPlugin(out.PLUGIN_VERSION, out.HOME);
    if (this.machine.sync) {
      // A sync that fails is logged, and the connection goes on without it.
      await this.syncSetup(out.HOME).catch((err) =>
        console.warn(`[sync] ${this.machine.name}: ${(err as Error).message}`),
      );
    }
    this.info = {
      home: out.HOME,
      missing: out.MISSING ? out.MISSING.split(' ') : [],
      loggedIn: out.LOGGED_IN === 'yes',
      pluginDir,
    };
    return this.info;
  }

  private async masterAlive(): Promise<boolean> {
    try {
      await execFile('ssh', ['-S', this.controlPath, '-O', 'check', this.machine.host], { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  private startMaster(): Promise<void> {
    const args = ['-M', '-N', '-S', this.controlPath, '-o', 'ControlPersist=no'];
    args.push('-o', 'BatchMode=yes', ...KEEPALIVE, this.machine.host);
    const master = spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.master = master;
    let stderr = '';
    master.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve();
      };
      master.on('exit', (code) => {
        if (this.master === master) {
          this.master = null;
          this.info = null;
          if (this.holders.size > 0) this.scheduleRelink();
        }
        settle(new Error(`Could not connect to ${this.machine.name}: ${stderr.trim() || `ssh exited with ${code}`}`));
      });
      const poll = setInterval(() => {
        this.masterAlive().then((alive) => alive && settle());
      }, 1000);
      const timeout = setTimeout(() => {
        master.kill();
        settle(new Error(`Timed out connecting to ${this.machine.name}`));
      }, CONNECT_TIMEOUT_MS);
    });
  }

  /** Brings the link back while a tab still holds it. */
  private scheduleRelink(): void {
    if (this.relinkTimer) return;
    this.relinkTimer = setTimeout(() => {
      this.relinkTimer = null;
      if (this.holders.size === 0) return;
      this.connect().catch((err) => {
        console.warn(`[remote] ${this.machine.name}: ${(err as Error).message}`);
        this.scheduleRelink();
      });
    }, RELINK_DELAY_MS);
  }

  private run(
    script: string,
    timeoutMs: number,
    remoteCommand = 'sh -s',
    stdin?: NodeJS.ReadableStream,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.sshOptions(), '-o', 'BatchMode=yes', this.machine.host, remoteCommand], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${this.machine.name}: ${stderr.trim() || `exited with ${code}`}`));
      });
      if (stdin) stdin.pipe(child.stdin);
      else child.stdin.end(script);
    });
  }

  /** Copies the plugin this Bifrost installed when the machine holds another version. */
  private async syncPlugin(remoteVersion: string | undefined, home: string): Promise<string | null> {
    const version = readPluginVersion(PLUGIN_DEPLOY_DIR);
    if (!version) return null;
    if (version !== remoteVersion) {
      const dest = REMOTE_PLUGIN_DIR;
      await this.sendTar(
        PLUGIN_DEPLOY_DIR,
        `rm -rf ${dest}.new && mkdir -p ${dest}.new && tar -xzf - -C ${dest}.new && rm -rf ${dest} && mv ${dest}.new ${dest}`,
        EXEC_TIMEOUT_MS,
      );
    }
    return `${home}/${REMOTE_PLUGIN_DIR}`;
  }

  /** Copies a local directory's contents into a fresh directory on the machine, relative to its home directory. */
  async upload(localDir: string, remoteDir: string): Promise<void> {
    await this.connect();
    await this.uploadOverLink(localDir, remoteDir);
  }

  /** upload, for a link that is open or being opened, which connect would wait on. */
  private async uploadOverLink(localDir: string, remoteDir: string): Promise<void> {
    // The remote login shell parses the command, so the path stays to characters it reads literally.
    if (!/^[A-Za-z0-9._/-]+$/.test(remoteDir)) throw new Error(`Unsafe remote directory: ${remoteDir}`);
    const command = `rm -rf ${remoteDir} && mkdir -p ${remoteDir} && tar -xzf - -C ${remoteDir}`;
    await this.sendTar(localDir, command, UPLOAD_TIMEOUT_MS);
  }

  /** Brings the machine's Claude setup in line with this one's, over the link being opened. */
  private async syncSetup(home: string): Promise<void> {
    const config = loadConfig();
    const { sent, removed } = await syncMachine(
      {
        upload: (localDir, remoteDir) => this.uploadOverLink(localDir, remoteDir),
        exec: (script) => this.run(script, UPLOAD_TIMEOUT_MS),
      },
      {
        localHome: os.homedir(),
        remoteHome: home,
        repoPaths: config.repos.filter((r) => !r.multiTaskId).map((r) => r.path),
        syncPaths: config.syncPaths ?? [],
        headroomDir: bifrostTool('headroom'),
      },
    );
    if (sent.length + removed.length > 0) {
      console.log(
        `[sync] ${this.machine.name}: sent ${sent.join(', ') || 'nothing'}; removed ${removed.join(', ') || 'nothing'}`,
      );
    }
  }

  private sendTar(localDir: string, remoteCommand: string, timeoutMs: number): Promise<string> {
    const tar = spawn('tar', ['--no-xattrs', '-C', localDir, '-czf', '-', '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return this.run('', timeoutMs, remoteCommand, tar.stdout);
  }
}

const hosts = new Map<string, RemoteHost>();

/** The configured machine by name, throwing with the names there are when it is not one of them. */
export function getRemoteHost(name: string): RemoteHost {
  const machines = loadConfig().machines ?? [];
  const machine = machines.find((m) => m.name === name);
  if (!machine) {
    const known = machines.map((m) => m.name).join(', ');
    throw new Error(
      known
        ? `No machine named "${name}". Configured machines: ${known}`
        : `No machine named "${name}". None are configured: add one in Bifrost's settings.`,
    );
  }
  const cached = hosts.get(name);
  if (cached && cached.machine.host === machine.host) return cached;
  cached?.close();
  const host = new RemoteHost(machine);
  hosts.set(name, host);
  return host;
}

/** Leaves the machines' sessions running, ending only the connections to them. */
export function closeRemoteHosts(): void {
  for (const host of hosts.values()) host.close();
  hosts.clear();
}
