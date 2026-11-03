/**
 * An instance links to the instance on another machine: it lists that one's
 * tasks, forwards their calls, and re-emits its events. This runs instance B
 * headless under a temporary home and links to it from here. Run with
 * `npm run check:peers`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, IPC_STREAM } from '../src/shared/ipc-channels.ts';
import type { Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(50);
  }
  return condition();
}

try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
} catch {
  console.log('skipped — no tmux');
  process.exit(0);
}

execFileSync('npm', ['run', '-s', 'build:headless'], { stdio: 'pipe' });

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-peers-')));
const homeA = path.join(root, 'a');
const homeB = path.join(root, 'b');
const stubs = path.join(root, 'stubs');
const tmp = path.join(root, 'tmp');
for (const dir of [homeA, homeB, stubs, tmp, path.join(homeB, '.bifrost')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\nprintf "stub\\n"\nexec cat\n', { mode: 0o755 });
// B holds an approval open until it is answered, so a routed answer can be seen to arrive.
fs.writeFileSync(path.join(homeB, '.bifrost', 'config.json'), JSON.stringify({ managePermissions: true }));
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');

// db.ts and peers.ts fix their paths as they load: B's database first, then this side's home.
process.env.HOME = homeB;
{
  const db = await import('../src/main/db.ts');
  const store = await import('../src/main/task-store.ts');
  db.openDatabase();
  const t1: Task = {
    id: 't1',
    name: 't1',
    repoId: 'r',
    baseBranch: 'main',
    worktreePath: tmp,
    status: 'stopped',
    hasUnread: false,
    createdAt: 1,
  };
  store.saveTasks([t1]);
  db.closeDatabase();
}
process.env.HOME = homeA;
const {
  closePeers,
  connectPeer,
  forwardTaskRoute,
  peerOf,
  peerTasks,
  postToPeer,
  refreshPeer,
  registerPeer,
  routeCall,
} = await import('../src/main/peers.ts');
const { subscribe } = await import('../src/main/event-sink.ts');

const env: NodeJS.ProcessEnv = { ...process.env, HOME: homeB, TMPDIR: tmp, TMUX_TMPDIR: root };
env.PATH = `${stubs}:${process.env.PATH}`;
delete env.CLAUDE_CONFIG_DIR;
delete env.TMUX;

let b: ChildProcess | undefined;
let portB = '';
const postB = (route: string, body: unknown) =>
  fetch(`http://127.0.0.1:${portB}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
const seen: Array<{ channel: string; args: unknown[]; origin?: string }> = [];
subscribe((channel, args, origin) => seen.push({ channel, args, origin }));
let localCalls = 0;
const local = () => {
  localCalls++;
  return 'local';
};

try {
  b = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => b?.on('exit', resolve));
  const portFile = path.join(homeB, '.bifrost', 'api-port');
  if (!(await until(() => fs.existsSync(portFile), 15_000))) throw new Error('B did not come up');
  portB = fs.readFileSync(portFile, 'utf8').trim();
  registerPeer('b', async () => Number(portB));

  {
    await connectPeer('b');
    const renamed = (await routeCall(IPC.RENAME_TASK, ['t1', 'x'], local)) as Task;
    const listed = peerTasks().find((t) => t.id === 't1');
    check(
      "a peer's tasks come back marked with its machine, and its calls run there",
      renamed?.name === 'x' &&
        localCalls === 0 &&
        listed?.machine === 'b' &&
        listed?.name === 'x' &&
        !listed.unreachable,
      show({ renamed, localCalls, listed }),
    );
  }

  {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    await postB('/call', { channel: IPC.ADD_REPO, args: [{ type: 'local', path: repo }] });
    const relayed = await until(
      () => seen.some((e) => e.channel === IPC_STREAM.REPOS_CHANGED && e.origin === 'b'),
      5_000,
    );

    const asking = postB('/permission', { bifrost_task_id: 't1', cwd: tmp, tool_name: 'Bash', tool_input: {} });
    const prompted = await until(() => seen.some((e) => e.channel === IPC_STREAM.PERMISSION_PROMPT), 5_000);
    const prompt = seen.find((e) => e.channel === IPC_STREAM.PERMISSION_PROMPT)?.args[0] as { requestId: string };
    if (prompt) await routeCall(IPC.RESOLVE_PERMISSION, [prompt.requestId, { action: 'allow', persist: false }], local);
    const answered = await Promise.race([asking.then((r) => r.status), sleep(5_000).then(() => 'still waiting')]);
    check(
      "a peer's events arrive here, and an answer to its request goes back to it",
      relayed && prompted && answered === 200 && localCalls === 0,
      show({ relayed, prompted, answered, localCalls }),
    );
  }

  {
    await postB('/hook', {
      cwd: tmp,
      bifrost_context: 'console',
      hook_event_name: 'Notification',
      message: 'hello from b',
      title: '',
    });
    const relayed = await until(() => seen.some((e) => e.channel === IPC_STREAM.CONSOLE_NOTIFICATION), 5_000);
    const note = seen.find((e) => e.channel === IPC_STREAM.CONSOLE_NOTIFICATION);
    const bell = seen.find((e) => e.channel === 'bell' && e.origin === 'b' && String(e.args[0]).startsWith('Console'));
    check(
      "a peer's console says which machine it is on",
      relayed && note?.args[2] === 'b' && bell?.args[0] === 'Console on b',
      show({ note: note?.args, bell: bell?.args }),
    );
  }

  {
    const t3: Task = {
      id: 't3',
      name: 't3',
      repoId: 'r',
      baseBranch: 'main',
      worktreePath: tmp,
      status: 'stopped',
      hasUnread: false,
      createdAt: 3,
    };
    await postToPeer('b', '/import-tasks', { tasks: [t3], repos: [] });
    await refreshPeer('b');
    const listed = peerTasks().find((t) => t.id === 't3');
    const forwarded = await forwardTaskRoute('/wake-task', { taskId: 't3' });
    const kept = await forwardTaskRoute('/wake-task', { taskId: 't-local' });
    check(
      "an API request about a peer's task is answered there, and one about a task here is not",
      forwarded !== null && 'ok' in forwarded && kept === null,
      show({ forwarded, kept }),
    );
    check(
      "a task handed to a peer shows up there, and is known to be the peer's",
      listed?.machine === 'b' && peerOf('t3') === 'b' && peerOf('t-unknown') === undefined,
      show({ listed, owner: peerOf('t3') }),
    );
  }

  {
    const from = seen.length;
    b.kill('SIGTERM');
    await exited;
    const noticed = await until(() => seen.slice(from).some((e) => e.channel === IPC_STREAM.TASKS_CHANGED), 5_000);
    const greyed = peerTasks().find((t) => t.id === 't1');
    const failure = await routeCall(IPC.RENAME_TASK, ['t1', 'y'], local).then(
      () => 'resolved',
      (err: Error) => err.message,
    );
    const told = seen.slice(from).some((e) => e.channel === IPC_STREAM.TOAST && String(e.args[0]).startsWith('b:'));
    check(
      'a peer that goes away leaves its last list, greyed, and its calls fail and say so',
      noticed && greyed?.unreachable === true && greyed.name === 'x' && failure.startsWith('b:') && told,
      show({ noticed, greyed, failure, told }),
    );
  }
} finally {
  closePeers();
  if (b && b.exitCode === null) b.kill('SIGKILL');
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
