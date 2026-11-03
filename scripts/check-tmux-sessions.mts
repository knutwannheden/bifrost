/**
 * A task session on this machine runs in tmux and is read through a control
 * client, so it outlives Bifrost and its tab gets the program's own bytes.
 * These run a real tmux on a server of their own, under a temporary home, with
 * a stub `claude`. Run with `npm run check:tmux-sessions`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { subscribe } from '../src/main/event-sink.ts';
import type { RemoteHost } from '../src/main/remote-host.ts';
import {
  attachLocalSession,
  attachSession,
  createRemoteSession,
  detachAllSessions,
  getSessionName,
  killSession,
  runningLocalSessions,
  waitForSessionReady,
  writeToSession,
} from '../src/main/session-manager.ts';
import { TmuxControl } from '../src/main/tmux-control.ts';
import { controlArgs, writeLocalSession } from '../src/main/tmux-session.ts';
import { IPC_STREAM } from '../src/shared/ipc-channels.ts';

const { Terminal } = headless;

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
} catch {
  console.log('skipped — no tmux');
  process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-sessions-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const worktree = path.join(root, 'worktree');
for (const dir of [home, stubs, worktree]) fs.mkdirSync(dir);
// The tmux server and every session take their environment from here.
process.env.HOME = home;
process.env.TMUX_TMPDIR = root;
process.env.PATH = `${stubs}:${process.env.PATH}`;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.TMUX;

// Prints a link, then a numbered line every 20 ms, echoes each line it reads, and ends on `q`.
fs.writeFileSync(
  path.join(stubs, 'claude'),
  `#!/bin/sh
( i=0; while :; do i=$((i+1)); printf 'n%d\\n' $i; sleep 0.02; done ) &
ticker=$!
sleep 0.5
printf '\\033]8;;https://example.com/stub\\033\\\\stub-link\\033]8;;\\033\\\\\\n'
while IFS= read -r line; do
  [ "$line" = q ] && break
  printf 'echo:%s\\n' "$line"
done
kill $ticker
`,
  { mode: 0o755 },
);

const events: Array<{ channel: string; id: string; data: unknown; replay?: boolean }> = [];
subscribe((channel, [id, data, replay]) =>
  events.push({ channel, id: id as string, data, replay: replay as boolean | undefined }),
);
const dataOf = (id: string) =>
  events.filter((e) => e.channel === IPC_STREAM.SESSION_DATA && e.id === id).map((e) => e.data as string);
const exitsOf = (id: string) => events.filter((e) => e.channel === IPC_STREAM.SESSION_EXIT && e.id === id).length;
// The test server's socket by path, so a check can never reach a real Bifrost server.
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');
const alive = (id: string) => {
  try {
    execFileSync('tmux', ['-S', socket, 'has-session', '-t', `=${id}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

function setUp(taskId: string, name = taskId) {
  writeLocalSession({
    home,
    taskId,
    worktreePath: worktree,
    sessionId: `0b8e2f34-0000-4000-8000-${taskId.padStart(12, '0').slice(-12)}`,
    claudeArgs: [],
    env: { BIFROST_SESSION_NAME: name },
  });
}

async function until(condition: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

/** What a tab shows after rejoining. The renderer drops what arrives before the replay, since the replay holds it. */
function shownAfterRejoin(from: number, id: string): string[] {
  const data = events.slice(from).filter((e) => e.channel === IPC_STREAM.SESSION_DATA && e.id === id);
  return data
    .slice(
      Math.max(
        0,
        data.findIndex((e) => e.replay === true),
      ),
    )
    .map((e) => e.data as string);
}

/** The numbered lines a terminal shows after being written these chunks. */
async function numbersShown(chunks: string[]): Promise<number[]> {
  const term = new Terminal({ cols: 80, rows: 10, scrollback: 1000, allowProposedApi: true });
  for (const chunk of chunks) await new Promise<void>((r) => term.write(chunk, r));
  const buffer = term.buffer.active;
  const numbers: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const match = /^n(\d+)$/.exec(buffer.getLine(i)?.translateToString(true) ?? '');
    if (match) numbers.push(Number(match[1]));
  }
  return numbers;
}
const lastNumber = (text: string) => Math.max(0, ...[...text.matchAll(/n(\d+)/g)].map((m) => Number(m[1])));

try {
  {
    setUp('bytes');
    attachLocalSession('bytes', { taskId: 'bytes' });
    await attachSession('bytes', 80, 10);
    const link = '\x1b]8;;https://example.com/stub\x1b\\stub-link\x1b]8;;\x1b\\';
    const arrived = await until(() => dataOf('bytes').join('').includes(link));
    check("a tab gets the session's own bytes", arrived, show(dataOf('bytes').join('').slice(-300)));
  }

  {
    setUp('rejoin');
    attachLocalSession('rejoin', { taskId: 'rejoin' });
    await attachSession('rejoin', 80, 10);
    await sleep(300);
    const before = lastNumber(dataOf('rejoin').join(''));
    detachAllSessions();
    await sleep(200);
    const from = events.length;
    attachLocalSession('rejoin', { taskId: 'rejoin' });
    await attachSession('rejoin', 80, 10);
    await sleep(300);
    const chunks = shownAfterRejoin(from, 'rejoin');
    const numbers = await numbersShown(chunks);
    const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
    check(
      'a session outlives detaching, and rejoining replays it once',
      before > 0 && consecutive && numbers[numbers.length - 1] > before + 10,
      show({ before, numbers }),
    );
  }

  {
    setUp('ready');
    attachLocalSession('ready', { taskId: 'ready' });
    await attachSession('ready', 80, 10);
    // A join is told from a fresh start by the session being older than the client.
    await sleep(1100);
    detachAllSessions();
    attachLocalSession('ready', { taskId: 'ready' });
    const ready = await waitForSessionReady('ready', 3000);
    check('a joined session that keeps printing is ready at once', ready);
  }

  {
    setUp('kill');
    attachLocalSession('kill', { taskId: 'kill' });
    await attachSession('kill', 80, 10);
    detachAllSessions();
    await sleep(100);
    const listed = runningLocalSessions().has('kill');
    const survived = alive('kill');
    killSession('kill');
    check(
      'a detached session is listed as running, and killing it ends its tmux session',
      listed && survived && !alive('kill') && !runningLocalSessions().has('kill'),
      show({ listed, survived, alive: alive('kill') }),
    );
  }
  setUp('exit');
  attachLocalSession('exit', { taskId: 'exit' });
  await attachSession('exit', 80, 10);
  await sleep(600);
  writeToSession('exit', 'q\r');
  await until(() => exitsOf('exit') > 0);
  await sleep(300);
  check('a session ending reports its exit once', exitsOf('exit') === 1, show(exitsOf('exit')));
  setUp('name', 'old');
  attachLocalSession('name', { taskId: 'name', name: 'old' });
  await attachSession('name', 80, 10);
  await sleep(300);
  detachAllSessions();
  setUp('name', 'new');
  attachLocalSession('name', { taskId: 'name', name: 'new' });
  check(
    'a rejoined session keeps the name it started under',
    getSessionName('name') === 'old',
    show(getSessionName('name')),
  );

  {
    setUp('twice');
    attachLocalSession('twice', { taskId: 'twice' });
    attachLocalSession('twice', { taskId: 'twice' });
    await attachSession('twice', 80, 10);
    await sleep(600);
    writeToSession('twice', 'x\r');
    await until(() => dataOf('twice').join('').includes('echo:x'));
    await sleep(300);
    const echoes = dataOf('twice').join('').split('echo:x').length - 1;
    check('attaching a session twice leaves one stream', echoes === 1, show(echoes));
  }

  {
    setUp('remote');
    // A host whose client is this machine's tmux. Its end is reported as 255, as ssh reports a dropped link.
    const host = {
      machine: { name: 'fake', host: 'fake' },
      hold() {},
      release() {},
      connect: async () => ({}),
      controlCommand: (taskId: string, cols: number, rows: number) => ({
        command: 'sh',
        args: ['-c', 'tmux "$@"; exit 255', 'sh', ...controlArgs(path.join(home, '.bifrost'), taskId, cols, rows)],
      }),
    } as unknown as RemoteHost;
    // Read here under another id than the tmux session's name, as a machine's console is.
    setUp('shared');
    createRemoteSession('shared@fake', host, { name: 'shared', tmuxName: 'shared' });
    await attachSession('shared@fake', 80, 10);
    const reached = await until(() => dataOf('shared@fake').join('').includes('stub-link'));
    check(
      'a session on another machine can be read under an id of its own',
      reached && alive('shared') && !alive('shared@fake'),
      show({ reached, shared: alive('shared') }),
    );
    killSession('shared@fake');

    createRemoteSession('remote', host, { name: 'remote' });
    await attachSession('remote', 80, 10);
    await sleep(300);
    const from = events.length;
    execFileSync('tmux', ['-S', socket, 'detach-client', '-s', 'remote']);
    const redrawn = await until(
      () =>
        events
          .slice(from)
          .some(
            (e) => e.channel === IPC_STREAM.SESSION_DATA && e.id === 'remote' && (e.data as string).startsWith('\x1bc'),
          ),
      8000,
    );
    check('a dropped connection reconnects and redraws the tab', redrawn && alive('remote'), show(alive('remote')));
    killSession('remote');
  }

  {
    setUp('sized');
    const base = path.join(home, '.bifrost');
    const tab = TmuxControl.start('tmux', controlArgs(base, 'sized', 80, 24), { cols: 80, rows: 24 });
    await tab.screen;
    // An instance reads its sessions with no screen of its own.
    const unseen = TmuxControl.start('tmux', controlArgs(base, 'sized', 120, 30, { ignoreSize: true }), {
      cols: 120,
      rows: 30,
    });
    await unseen.screen;
    await sleep(300);
    const width = execFileSync('tmux', ['-S', socket, 'list-windows', '-t', '=sized', '-F', '#{window_width}'], {
      encoding: 'utf-8',
    }).trim();
    check('a client that ignores its size leaves the window to the tab', width === '80', show(width));
    tab.detach();
    unseen.detach();
    killSession('sized');
  }

  {
    // Loaded after HOME is set, since it settles its directory as it loads.
    const consoleService = await import('../src/main/console-service.ts');
    consoleService.initConsole();
    await attachSession('console', 80, 10);
    await sleep(400);
    const before = lastNumber(dataOf('console').join(''));
    detachAllSessions();
    const from = events.length;
    consoleService.initConsole();
    await attachSession('console', 80, 10);
    await sleep(300);
    const chunks = shownAfterRejoin(from, 'console');
    const numbers = await numbersShown(chunks);
    check(
      'a console started again joins the one still running',
      before > 0 && numbers[0] === 1 && numbers[numbers.length - 1] > before + 5,
      show({ before, numbers }),
    );
  }
} finally {
  detachAllSessions();
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
