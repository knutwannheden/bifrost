/**
 * A task follows its session into another worktree, and reopening it resumes
 * the conversation there. Runs a headless instance under a temporary home with
 * a stub Claude that records where and how it was started. Run with
 * `npm run check:worktree-follow`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDir } from '../src/main/claude-paths.ts';
import { IPC } from '../src/shared/ipc-channels.ts';
import type { Task } from '../src/shared/types.ts';

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

execFileSync('npm', ['run', '-s', 'build:headless'], { stdio: 'pipe' });

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-follow-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const record = path.join(root, 'record');
const tmp = path.join(root, 'tmp');
const repo = path.join(root, 'repo');
for (const dir of [path.join(home, '.bifrost'), stubs, tmp, repo]) fs.mkdirSync(dir, { recursive: true });
// Each start is a line of NUL-separated fields, the directory first, since the instance's console starts Claude too.
fs.writeFileSync(
  path.join(stubs, 'claude'),
  `#!/bin/sh\nprintf '%s\\0' "$PWD" "$@" >> '${record}'\necho >> '${record}'\nexec cat\n`,
  { mode: 0o755 },
);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim();
git('init', '-q', '-b', 'main');
git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');

const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, TMUX_TMPDIR: root };
env.PATH = `${stubs}:${process.env.PATH}`;
delete env.CLAUDE_CONFIG_DIR;
delete env.TMUX;
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');
const portFile = path.join(home, '.bifrost', 'api-port');

let instance: ChildProcess | undefined;
let port = '';
async function start(): Promise<void> {
  fs.rmSync(portFile, { force: true });
  instance = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  for (const end = Date.now() + 15_000; !fs.existsSync(portFile) && Date.now() < end; ) await sleep(50);
  port = fs.readFileSync(portFile, 'utf8').trim();
}
const post = async (route: string, body: unknown) =>
  (await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())) as Record<string, unknown>;
const call = async (channel: string, ...args: unknown[]) => (await post('/call', { channel, args })).result;
const starts = (): Array<{ dir: string; args: string[] }> =>
  (fs.existsSync(record) ? fs.readFileSync(record, 'utf-8') : '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\0').slice(0, -1))
    .map(([dir, ...args]) => ({ dir, args }));
async function startIn(dir: string): Promise<string[] | undefined> {
  for (const end = Date.now() + 10_000; Date.now() < end; await sleep(50)) {
    const found = starts().find((s) => s.dir === dir);
    if (found) return found.args;
  }
  return starts().at(-1)?.args;
}

try {
  await start();
  const created = (await post('/create-task', { repoPath: repo, name: 'moving', prompt: 'go' })) as Task;
  const first = created.worktreePath;
  await startIn(first);
  const sessionId = fs.readFileSync(path.join(home, '.bifrost', 'sessions', created.id, 'session-id'), 'utf8').trim();
  const hook = { session_id: sessionId, bifrost_context: 'code', bifrost_task_id: created.id };
  await post('/session-start', { ...hook, cwd: first, source: 'startup' });
  const transcriptIn = (dir: string) =>
    path.join(home, '.claude', 'projects', claudeProjectDir(dir), `${sessionId}.jsonl`);
  const enter = (dir: string, transcript: string, extra: object = {}) =>
    post('/hook', {
      ...hook,
      ...extra,
      cwd: dir,
      transcript_path: transcript,
      hook_event_name: 'PostToolUse',
      tool_name: 'EnterWorktree',
      tool_input: { path: dir },
      tool_response: { worktreePath: dir, worktreeBranch: path.basename(dir) },
    });

  const second = path.join(repo, '.worktrees', 'second');
  git('worktree', 'add', '-q', '-b', 'second', second);
  fs.writeFileSync(path.join(second, 'moved.txt'), 'made after the move\n');
  await enter(second, transcriptIn(second));

  {
    const { diff } = (await post('/get-task-diff', { taskId: created.id })) as { diff?: string };
    const task = ((await call(IPC.LIST_TASKS)) as Task[]).find((t) => t.id === created.id);
    check(
      'after its session enters another worktree, the task shows that worktree and its branch',
      !!diff?.includes('made after the move') && task?.branch === 'second',
      show({ diff, branch: task?.branch, worktreePath: task?.worktreePath }),
    );
  }

  {
    const third = path.join(repo, '.worktrees', 'third');
    git('worktree', 'add', '-q', '-b', 'third', third);
    await enter(third, transcriptIn(second), { agent_id: 'a1', agent_type: 'general-purpose' });
    const task = ((await call(IPC.LIST_TASKS)) as Task[]).find((t) => t.id === created.id);
    check(
      'a subagent entering a worktree leaves the task where its session is',
      task?.worktreePath === second,
      show(task?.worktreePath),
    );
  }

  {
    // As Claude does on entering it, and as the session did with the worktree it left.
    fs.mkdirSync(path.dirname(transcriptIn(second)), { recursive: true });
    fs.writeFileSync(transcriptIn(second), `${'{}\n'.repeat(4096)}`);
    git('worktree', 'remove', '--force', first);

    await call(IPC.ARCHIVE_TASK, created.id);
    await call(IPC.REOPEN_TASK, created.id);
    const args = await startIn(second);
    const last = starts().at(-1);
    check(
      'reopening the task resumes its conversation in the worktree its session moved to',
      last?.dir === second && !!args?.includes('--resume') && args.includes(sessionId),
      show(last),
    );
  }
} finally {
  if (instance && instance.exitCode === null) instance.kill('SIGKILL');
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
