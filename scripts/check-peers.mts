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
import type { Repo, Task } from '../src/shared/types.ts';

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
// Every repo has one open PR, from the branch `feature`.
fs.writeFileSync(
  path.join(stubs, 'gh'),
  `#!/bin/sh
case "$*" in
  --version) echo "gh version 2.0.0" ;;
  "pr list"*"--state all"*) echo '[{"number":7,"state":"OPEN","isDraft":false,"headRefName":"feature","url":"https://github.com/org/p/pull/7"}]' ;;
  *) exit 1 ;;
esac
`,
  { mode: 0o755 },
);
// B holds an approval open until it is answered, so a routed answer can be seen to arrive.
fs.writeFileSync(path.join(homeB, '.bifrost', 'config.json'), JSON.stringify({ managePermissions: true }));
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');

// Each side gives the same GitHub repo its own id.
const repoHere = (id: string, slug: string): Repo => ({
  id,
  name: slug,
  path: path.join(homeA, slug),
  defaultBranch: 'main',
  githubPath: `org/${slug}`,
});
fs.mkdirSync(path.join(homeA, '.bifrost'));
fs.writeFileSync(
  path.join(homeA, '.bifrost', 'config.json'),
  JSON.stringify({ repos: [repoHere('ra', 'r'), repoHere('sa', 's')] }),
);
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

// peers.ts and config.ts fix their paths as they load.
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
let c: ChildProcess | undefined;
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

const portFile = path.join(homeB, '.bifrost', 'api-port');
/** Starts B, and answers once it has written its port. */
async function startB(): Promise<{ exited: Promise<unknown> }> {
  fs.rmSync(portFile, { force: true });
  b = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => b?.on('exit', resolve));
  if (!(await until(() => fs.existsSync(portFile), 15_000))) throw new Error('B did not come up');
  portB = fs.readFileSync(portFile, 'utf8').trim();
  return { exited };
}

// B's own event stream, read directly, where an empty line is a beat.
let beats = 0;
const raw = new AbortController();

try {
  const { exited } = await startB();
  void fetch(`http://127.0.0.1:${portB}/events`, { method: 'POST', body: '{}', signal: raw.signal })
    .then(async (res) => {
      let rest = '';
      for await (const chunk of res.body ?? []) {
        const lines = (rest + Buffer.from(chunk).toString()).split('\n');
        rest = lines.pop() ?? '';
        beats += lines.filter((line) => line === '').length;
      }
    })
    .catch(() => {});
  registerPeer('b', async () => Number(portB));
  await postB('/import-tasks', { tasks: [t1], repos: [{ ...repoHere('r', 'r'), path: path.join(homeB, 'r') }] });

  {
    await connectPeer('b');
    const renamed = (await routeCall(IPC.RENAME_TASK, ['t1', 'x'], local)) as Task;
    const listed = peerTasks().find((t) => t.id === 't1');
    check(
      "a peer's tasks come back marked with its machine and this side's repo, and its calls run there",
      renamed?.name === 'x' &&
        localCalls === 0 &&
        listed?.machine === 'b' &&
        listed?.repoId === 'ra' &&
        listed?.name === 'x' &&
        !listed.unreachable,
      show({ renamed, localCalls, listed }),
    );
  }

  {
    const repo = path.join(root, 's');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/org/s.git']);
    execFileSync('git', [
      '-C',
      repo,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      's',
    ]);
    const from = seen.length;
    const created = (await (await postB('/create-task', { repoPath: repo, name: 'in s' })).json()) as Task;
    const arrived = await until(() => peerTasks().some((t) => t.id === created.id), 5_000);
    const listed = peerTasks().find((t) => t.id === created.id);
    const passedOn = seen.slice(from).some((e) => e.channel === IPC_STREAM.REPOS_CHANGED);
    check(
      "a task a peer creates in a repo new to it shows this side's repo, and the peer's repo list stays the peer's",
      arrived && listed?.repoId === 'sa' && !passedOn,
      show({ created, listed, passedOn }),
    );
  }

  {
    const asking = postB('/permission', { bifrost_task_id: 't1', cwd: tmp, tool_name: 'Bash', tool_input: {} });
    const prompted = await until(() => seen.some((e) => e.channel === IPC_STREAM.PERMISSION_PROMPT), 5_000);
    const prompt = seen.find((e) => e.channel === IPC_STREAM.PERMISSION_PROMPT)?.args[0] as { requestId: string };
    if (prompt) await routeCall(IPC.RESOLVE_PERMISSION, [prompt.requestId, { action: 'allow', persist: false }], local);
    const answered = await Promise.race([asking.then((r) => r.status), sleep(5_000).then(() => 'still waiting')]);
    check(
      "a peer's events arrive here, and an answer to its request goes back to it",
      prompted && answered === 200 && localCalls === 0,
      show({ prompted, answered, localCalls }),
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
    const consoleHook = (hook_event_name: string) =>
      postB('/hook', { cwd: tmp, bifrost_context: 'console', hook_event_name });
    const busy = async () => {
      const answer = (await (await postB('/call', { channel: IPC.CONSOLE_STATE, args: [] })).json()) as {
        result?: { busy?: boolean };
      };
      return answer.result?.busy;
    };
    await consoleHook('UserPromptSubmit');
    const working = await busy();
    await consoleHook('Stop');
    const done = await busy();
    check(
      'a console is busy from the prompt it is given to the end of its turn',
      working === true && done === false,
      show({ working, done }),
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
    // C stands in for the IDE, which an instance on a machine links back to.
    const homeC = path.join(root, 'c');
    const portFileC = path.join(homeC, '.bifrost', 'api-port');
    fs.mkdirSync(path.dirname(portFileC), { recursive: true });
    c = spawn('node', ['.vite/headless/headless.js'], { env: { ...env, HOME: homeC }, stdio: 'ignore' });
    if (!(await until(() => fs.existsSync(portFileC), 15_000))) throw new Error('C did not come up');
    const portC = Number(fs.readFileSync(portFileC, 'utf8').trim());
    const postC = (route: string, body: unknown) =>
      fetch(`http://127.0.0.1:${portC}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const prsOnB = async (id: string, ms: number) => {
      let prs: Record<string, { number: number }> = {};
      for (const end = Date.now() + ms; !prs[id] && Date.now() < end; await sleep(200)) {
        const answer = (await (await postB('/call', { channel: IPC.GET_TASK_PRS, args: [] })).json()) as {
          result?: typeof prs;
        };
        prs = answer.result ?? {};
      }
      return prs;
    };
    const repoP = (id: string): Repo => ({ id, name: 'p', path: tmp, defaultBranch: 'main', githubPath: 'org/p' });
    const tc: Task = { ...t1, id: 'tc', repoId: 'pc', branch: 'feature' };
    // The worktree has moved on from the branch C recorded for the task.
    const moved = path.join(root, 'moved');
    execFileSync('git', ['init', '-q', '-b', 'feature', moved]);
    const tm: Task = { ...t1, id: 'tm', repoId: 'pc', branch: 'old', worktreePath: moved };
    await postC('/import-tasks', { tasks: [tc, tm], repos: [repoP('pc')] });
    await postB('/import-tasks', { tasks: [], repos: [repoP('pb')] });
    await postB('/link-back', { name: 'c', port: portC });

    const prs = await prsOnB('tc', 10_000);
    check("a peer's task shows the PR its branch has", prs.tc?.number === 7, show(prs));

    // C has no window asking for PRs, so the branch moves only when C's own refresh comes round.
    const afterMove = await prsOnB('tm', 40_000);
    check(
      "a peer's task whose worktree moved to another branch shows that branch's PR",
      afterMove.tm?.number === 7,
      show(afterMove),
    );
  }

  {
    const beat = await until(() => beats > 0, 20_000);
    raw.abort();
    check(
      "an instance's event stream beats every 15 seconds, so a reader that gives up on a silent one stays",
      beat,
      show({ beats }),
    );
  }

  {
    const from = seen.length;
    b?.kill('SIGTERM');
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

  {
    // A second copy of the module starts from what the first left on disk, as after a restart here.
    const restarted = (await import('../src/main/peers.ts?restarted')) as typeof import('../src/main/peers.ts');
    restarted.registerPeer('b', async () => Number(portB));
    const greyed = restarted.peerTasks().find((t) => t.id === 't1');
    check(
      "after a restart here, a peer that is away still shows its last list with this side's repo",
      greyed?.unreachable === true && greyed.repoId === 'ra',
      show({ greyed }),
    );
  }

  {
    await startB();
    const back = await until(() => peerTasks().find((t) => t.id === 't1')?.unreachable !== true, 30_000);
    check(
      'a peer that comes back is linked again without anything asking for it',
      back,
      show({ listed: peerTasks().find((t) => t.id === 't1') }),
    );
  }
} finally {
  raw.abort();
  closePeers();
  if (b && b.exitCode === null) b.kill('SIGKILL');
  if (c && c.exitCode === null) c.kill('SIGKILL');
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
