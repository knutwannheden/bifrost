/**
 * The hooks Claude, Codex and Copilot raise move a task between working and
 * idle as the agent does. Runs a headless instance under a temporary home and
 * posts hooks to it as the plugin's scripts do. Run with `npm run check:agent-hooks`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC } from '../src/shared/ipc-channels.ts';
import type { SessionState, Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

execFileSync('npm', ['run', '-s', 'build:headless'], { stdio: 'pipe' });

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-hooks-')));
const home = path.join(root, 'home');
const tmp = path.join(root, 'tmp');
for (const dir of [path.join(home, '.bifrost'), tmp]) fs.mkdirSync(dir, { recursive: true });
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, TMUX_TMPDIR: root };
delete env.CLAUDE_CONFIG_DIR;
delete env.TMUX;

const portFile = path.join(home, '.bifrost', 'api-port');
const instance: ChildProcess = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
let port = '';
const post = async (route: string, body: unknown) =>
  (await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())) as Record<string, unknown>;
const call = async (channel: string, ...args: unknown[]) => (await post('/call', { channel, args })).result;
const hook = (event: string, extra: Record<string, unknown> = {}) =>
  post('/hook', { hook_event_name: event, bifrost_task_id: 't1', bifrost_context: 'code', cwd: tmp, ...extra });
const busy = async () => ((await call(IPC.SESSION_STATE, 't1')) as SessionState).busy;

try {
  for (const end = Date.now() + 15_000; !fs.existsSync(portFile) && Date.now() < end; ) await sleep(50);
  port = fs.readFileSync(portFile, 'utf8').trim();
  const t1: Task = {
    id: 't1',
    name: 't1',
    repoId: 'r',
    baseBranch: 'main',
    worktreePath: tmp,
    status: 'stopped',
    hasUnread: false,
    createdAt: 1,
    sessionId: 's1',
  };
  await post('/import-tasks', { tasks: [t1], repos: [] });

  {
    await hook('UserPromptSubmit');
    await hook('Notification', { notification_type: 'shell_completed' });
    const afterShell = await busy();
    await hook('Notification', { notification_type: 'permission_prompt' });
    const afterPrompt = await busy();
    check(
      'a notification that a shell finished leaves the task working, and one that asks for the user leaves it idle',
      afterShell === true && afterPrompt === false,
      show({ afterShell, afterPrompt }),
    );
  }

  {
    await hook('UserPromptSubmit');
    await hook('Interrupt');
    const after = await busy();
    check('a turn the user interrupts leaves the task idle', after === false, show({ after }));
  }

  {
    await post('/session-start', {
      hook_event_name: 'SessionStart',
      source: 'fork',
      session_id: 'f1',
      bifrost_task_id: 't1',
      bifrost_context: 'code',
      cwd: tmp,
    });
    const tasks = (await call(IPC.LIST_TASKS)) as Task[];
    const sessionId = tasks.find((t) => t.id === 't1')?.sessionId;
    check("a fork's session start leaves the task's session as it was", sessionId === 's1', show({ sessionId }));
  }
} finally {
  instance.kill('SIGTERM');
  await sleep(300);
  if (instance.exitCode === null) instance.kill('SIGKILL');
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
