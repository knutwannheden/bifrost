import { type ChildProcess, execFile as execFileCb, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Machine } from '../shared/types.ts';
import { TRUSTED_ENTRY } from './claude-trust.ts';
import { loadConfig } from './config.ts';
import { pack, plan } from './instance-deploy.ts';
import { PLUGIN_DEPLOY_DIR, readPluginVersion } from './integration-installer.ts';
import { syncMachine } from './remote-sync.ts';
import {
  controlArgs,
  type SessionSpec,
  sessionDir,
  sessionFiles,
  shQuote,
  TMUX_SOCKET,
  tmuxConf,
} from './tmux-session.ts';

export { shQuote };

const execFile = promisify(execFileCb);

// Each script is handed to `sh -s` on the machine's stdin, so the remote login
// shell, whichever it is, never parses a quoted value.

/** Bifrost's directory on a machine, relative to the home directory `ssh` starts in. */
const REMOTE_DIR = '.bifrost';
/** A Bifrost install deletes `.bifrost/plugin` as a leftover, so the copy lives under another name. */
const REMOTE_PLUGIN_DIR = `${REMOTE_DIR}/claude-plugin`;

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

/** Writes the files a task's session runs from, and trusts its worktree. */
export function sessionSetupScript(spec: SessionSpec): string {
  const dir = `${spec.home}/${sessionDir(spec.taskId)}`;
  return [
    'set -e',
    `python3 -c ${shQuote(TRUST_PY)} ${shQuote(spec.worktreePath)} ${shQuote(JSON.stringify(TRUSTED_ENTRY))} || true`,
    `d=${shQuote(dir)}`,
    'mkdir -p "$d"',
    ...Object.entries(sessionFiles(spec)).map(([name, content]) => `printf '%s\\n' ${shQuote(content)} > "$d/${name}"`),
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
export function prepareScript(opts: { apiPort: number; theme?: string; instance?: boolean }): string {
  const onboarding = { hasCompletedOnboarding: true, ...(opts.theme ? { theme: opts.theme } : {}) };
  return [
    'set -e',
    'cd "$HOME"',
    `mkdir -p ${REMOTE_DIR}/sessions`,
    // On a machine that runs its own instance, api-port is that instance's, and the IDE's API is the peer it links back to.
    `printf '%s\\n' ${opts.apiPort} > ${REMOTE_DIR}/${opts.instance ? 'ide-port' : 'api-port'}`,
    `printf '%s' ${shQuote(tmuxConf())} > ${REMOTE_DIR}/tmux.conf`,
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

const INSTANCE_DIR = `${REMOTE_DIR}/instance`;
/** The port file the instance writes for itself. */
const INSTANCE_PORT_FILE = `${REMOTE_DIR}/instance-port`;
const TMUX = `tmux -L ${TMUX_SOCKET} -f ${REMOTE_DIR}/tmux.conf`;

/** Answers whether an instance's API answers on port $1 within 2 s. */
const PROBE = [
  'probe() {',
  `  node -e "fetch('http://127.0.0.1:'+process.argv[1]+'/list-tasks',{method:'POST',body:'{}',signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))" "$1" 2>/dev/null`,
  '}',
];

/** Prints INSTANCE_HASH, the build there, and INSTANCE_PORT when its API answers. */
export function instanceStatusScript(): string {
  return [
    'cd "$HOME" || exit 1',
    ...PROBE,
    `printf 'INSTANCE_HASH=%s\\n' "$(cat ${INSTANCE_DIR}/build-hash 2>/dev/null)"`,
    `port=$(cat ${INSTANCE_PORT_FILE} 2>/dev/null)`,
    `if [ -n "$port" ] && probe "$port"; then printf 'INSTANCE_PORT=%s\\n' "$port"; fi`,
  ].join('\n');
}

/**
 * Installs the build unpacked into instance.new and puts it in place. A failure
 * leaves the instance there as it was.
 */
export function installInstanceScript(hash: string): string {
  return [
    'set -e',
    'cd "$HOME"',
    `cd ${INSTANCE_DIR}.new`,
    'npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null',
    `printf '%s\\n' ${shQuote(hash)} > build-hash`,
    'cd "$HOME"',
    `rm -rf ${INSTANCE_DIR}`,
    `mv ${INSTANCE_DIR}.new ${INSTANCE_DIR}`,
  ].join('\n');
}

/**
 * (Re)starts the instance in a respawn loop in Bifrost's tmux server, then
 * prints INSTANCE_PORT once its API answers. The loop restarts it after a
 * crash, and the other tmux sessions are left alone.
 */
export function startInstanceScript(machine: string): string {
  return [
    'cd "$HOME" || exit 1',
    ...PROBE,
    `${TMUX} kill-session -t =instance 2>/dev/null || true`,
    // The instance stopping gives up its port file, and a new one must not race it.
    'i=0',
    `while [ -f ${INSTANCE_PORT_FILE} ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done`,
    `rm -f ${INSTANCE_PORT_FILE}`,
    // Given as separate arguments, tmux runs it without the login shell, which need not be sh.
    `${TMUX} new-session -d -s instance sh -c ${shQuote(`cd "$HOME/${INSTANCE_DIR}" && while :; do BIFROST_MACHINE=${shQuote(machine)} BIFROST_PLUGIN_DIR="$HOME/${REMOTE_PLUGIN_DIR}" node headless.js; sleep 2; done`)}`,
    'i=0',
    'while [ $i -lt 300 ]; do',
    `  port=$(cat ${INSTANCE_PORT_FILE} 2>/dev/null)`,
    `  if [ -n "$port" ] && probe "$port"; then printf 'INSTANCE_PORT=%s\\n' "$port"; exit 0; fi`,
    '  sleep 0.1',
    '  i=$((i+1))',
    'done',
    "echo 'the instance did not answer within 30 s' >&2",
    'exit 1',
  ].join('\n');
}

/**
 * Settings a remote session starts with. On a machine where nobody ran Claude by
 * hand, its offer of the fullscreen renderer and its warning about skipped
 * permissions would each hold the prompt back. Remote Control follows this machine.
 */
/**
 * What a session started by an instance on another machine needs, where nobody
 * may ever have run Claude by hand: the plugin the IDE copied there, the
 * settings a remote session starts with, and the machine's name. Empty in the IDE.
 */
export function machineSession(
  permissionMode: string | undefined,
  remoteControl: boolean,
): { settings: Record<string, unknown>; args: string[]; env: Record<string, string> } {
  const dir = process.env.BIFROST_PLUGIN_DIR;
  if (!dir) return { settings: {}, args: [], env: {} };
  const machine = process.env.BIFROST_MACHINE;
  return {
    settings: remoteSessionSettings(permissionMode, remoteControl),
    args: ['--plugin-dir', dir],
    env: machine ? { BIFROST_MACHINE: machine } : {},
  };
}

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

/** A port nothing on this machine's loopback listens on, for a forward to take. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** The holder that keeps the connection open for the instance's forward. */
const INSTANCE_HOLDER = 'instance';

/**
 * Whether a dropped connection is brought back at once: only for a session
 * still holding it. The instance reconnects at its next use, since connecting
 * starts a machine that stopped.
 */
export function relinks(holders: ReadonlySet<string>): boolean {
  return [...holders].some((h) => h !== INSTANCE_HOLDER);
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
  /** The forward to the machine's instance, which a new master connection no longer has. */
  private instanceForward: { localPort: number; remotePort: number } | null = null;
  private ensuring: Promise<number> | null = null;
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

  /**
   * The command that attaches a tmux control client to the task's session on
   * the machine, starting it when it is missing. The login shell there reads
   * the remote command, whose every word is safe for it unquoted.
   */
  controlCommand(taskId: string, cols: number, rows: number): { command: string; args: string[] } {
    const remote = ['tmux', ...controlArgs(REMOTE_DIR, taskId, cols, rows)].join(' ');
    return { command: 'ssh', args: [...this.sshOptions(), '-T', '-o', 'BatchMode=yes', this.machine.host, remote] };
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

  /**
   * Brings the machine's Bifrost instance up to the build here and running, and
   * answers a port on this machine's loopback forwarded to its API. The
   * connection stays open from then on, since the forward lives on it.
   */
  ensureInstance(): Promise<number> {
    this.ensuring ??= this.bringUpInstance().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  private async bringUpInstance(): Promise<number> {
    await this.connectReady();
    const packed = await pack(process.cwd());
    const status = parseScriptOutput(await this.exec(instanceStatusScript()));
    let remotePort = Number(status.INSTANCE_PORT) || undefined;
    const step = plan({ hash: status.INSTANCE_HASH || undefined, port: remotePort }, packed.hash);
    if (step === 'install') {
      await this.sendTar(
        packed.dir,
        `rm -rf ${INSTANCE_DIR}.new && mkdir -p ${INSTANCE_DIR}.new && tar -xzf - -C ${INSTANCE_DIR}.new`,
        UPLOAD_TIMEOUT_MS,
      );
      await this.exec(installInstanceScript(packed.hash), UPLOAD_TIMEOUT_MS);
    }
    if (step !== 'none')
      remotePort = Number(parseScriptOutput(await this.exec(startInstanceScript(this.machine.name))).INSTANCE_PORT);
    if (!remotePort) throw new Error(`${this.machine.name}: its instance did not report a port`);
    const localPort = await this.forwardInstance(remotePort);
    this.hold(INSTANCE_HOLDER);
    return localPort;
  }

  private async forwardInstance(remotePort: number): Promise<number> {
    const current = this.instanceForward;
    if (current?.remotePort === remotePort) return current.localPort;
    if (current) await this.controlForward('cancel', current).catch(() => {});
    const forward = { localPort: await freePort(), remotePort };
    await this.controlForward('forward', forward);
    this.instanceForward = forward;
    return forward.localPort;
  }

  private controlForward(op: 'forward' | 'cancel', ports: { localPort: number; remotePort: number }) {
    const spec = `127.0.0.1:${ports.localPort}:127.0.0.1:${ports.remotePort}`;
    return execFile('ssh', ['-S', this.controlPath, '-O', op, '-L', spec, this.machine.host], { timeout: 30_000 });
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
    this.instanceForward = null;
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
      this.instanceForward = null;
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
    const prepare = prepareScript({
      apiPort: forwarded,
      theme: typeof theme === 'string' ? theme : undefined,
      instance: this.machine.instance === true,
    });
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
          this.holders.delete(INSTANCE_HOLDER);
          this.instanceForward = null;
          if (relinks(this.holders)) this.scheduleRelink();
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
      if (!relinks(this.holders)) return;
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
