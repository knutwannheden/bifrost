import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { IPC } from '../src/shared/ipc-channels.ts';
import type { Task } from '../src/shared/types.ts';

execFileSync('npm', ['run', '-s', 'build:headless'], { stdio: 'pipe' });

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'epic-routing-')));
const cleanups: Array<() => Promise<void>> = [];
const bin = path.join(root, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ready(value)) return value;
    await sleep(50);
  }
  throw new Error('Waited for the instance to become ready');
}

async function start(name: string, machine = '') {
  const home = path.join(root, name);
  const portFile = path.join(home, '.bifrost', 'instance-port');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: home,
    TMUX_TMPDIR: home,
    BIFROST_MACHINE: machine,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
  delete env.TMUX;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.BIFROST_PLUGIN_DIR;
  const child = spawn('node', ['.vite/headless/headless.js'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const ended = once(child, 'exit');
  cleanups.push(async () => {
    child.kill('SIGTERM');
    await ended;
    try {
      execFileSync('tmux', ['-L', 'bifrost', 'kill-server'], { env, stdio: 'ignore' });
    } catch {}
  });
  const port = await until(
    () => {
      if (child.exitCode !== null) throw new Error(stderr);
      return fs.existsSync(portFile) ? Number(fs.readFileSync(portFile, 'utf8')) : 0;
    },
    (value) => value !== 0,
  );
  const post = async (route: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    return { status: res.status, body: await res.json() };
  };
  return { port, post };
}

const stopped = (id: string): Task => ({
  id,
  name: id,
  repoId: 'repo',
  baseBranch: 'main',
  worktreePath: root,
  status: 'stopped',
  hasUnread: false,
  createdAt: 1,
});

try {
  const [ide, design, perf] = await Promise.all([start('ide'), start('design', 'design'), start('perf', 'perf')]);
  const brief = { goal: 'Measure a candidate', template: 'Assign a measurer.' };
  const epic = { ...stopped('epic'), epic: { ...brief, updates: [], checkedThrough: 0 } };
  const worker = { ...stopped('worker'), createdByTaskId: 'former-coordinator' };
  const repoPath = path.join(root, 'project');
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  execFileSync('git', [
    '-C',
    repoPath,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.com',
    'commit',
    '-qm',
    'Initial test commit',
    '--allow-empty',
  ]);
  const repo = { id: 'repo', name: 'project', path: repoPath, defaultBranch: 'main', githubPath: 'example/project' };
  assert.equal(
    (
      await ide.post('/import-tasks', {
        tasks: [{ ...stopped('ide-task'), repoId: 'ide-repo' }],
        repos: [{ ...repo, id: 'ide-repo' }],
      })
    ).status,
    200,
  );
  assert.equal((await design.post('/epic/import', { tasks: [epic], repos: [repo] })).status, 200);
  assert.equal((await perf.post('/import-tasks', { tasks: [worker] })).status, 200);

  await Promise.all([
    ide.post('/link-back', { name: 'design', port: design.port }),
    ide.post('/link-back', { name: 'perf', port: perf.port }),
    design.post('/link-back', { name: 'ide', port: ide.port }),
    perf.post('/link-back', { name: 'ide', port: ide.port }),
  ]);
  await until(
    () => ide.post('/list-tasks', { status: 'all' }),
    ({ body }) =>
      body.tasks?.some((task: Task) => task.id === 'epic') && body.tasks?.some((task: Task) => task.id === 'worker'),
  );
  await Promise.all(
    [design, perf].map((instance) =>
      until(
        () => instance.post('/list-tasks', { status: 'all' }),
        ({ body }) => body.tasks?.some((task: Task) => task.id === 'ide-task'),
      ),
    ),
  );

  const coordinator = { taskId: 'epic', callerTaskId: 'epic' };
  const attached = await design.post('/epic/update', { ...coordinator, change: { kind: 'attach', taskId: 'worker' } });
  assert.equal(attached.status, 200, JSON.stringify(attached.body));
  assert.equal(
    (
      await design.post('/epic/update', {
        ...coordinator,
        change: { kind: 'item', id: 'measure', title: 'Measure', status: 'open', taskId: 'worker' },
      })
    ).status,
    200,
  );
  const report = await perf.post('/epic/report', {
    taskId: 'epic',
    callerTaskId: 'worker',
    itemId: 'measure',
    reportId: 'timings',
    text: 'Candidate median was 36 ms.',
  });
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.update.authorTaskId, 'worker');
  const state = await perf.post('/epic/get', { taskId: 'epic', callerTaskId: 'worker' });
  assert.deepEqual(
    state.body.state.members.map(({ id, machine }: { id: string; machine: string }) => [id, machine]),
    [['worker', 'perf']],
  );
  assert.equal(state.body.state.epic.updates.at(-1).reportId, 'timings');
  console.log('ok — a sibling instance reports to an epic on another machine through the IDE');

  const message = await perf.post('/message-task', { taskId: 'epic', fromTaskId: 'worker', text: 'Timings ready.' });
  assert.equal(message.body.error, 'Task is stopped, not running');
  const missing = await perf.post('/message-task', { taskId: 'missing', fromTaskId: 'worker', text: 'Hello.' });
  assert.match(missing.body.error, /Task missing not found/);
  console.log('ok — messages use the same sibling route and an unknown recipient terminates');

  const checkIn = await design.post('/call', { channel: IPC.EPIC_CHECK_IN, args: ['epic', report.body.update.seq] });
  assert.equal(checkIn.body.result, report.body.update.seq);
  console.log('ok — the epic owner applies the window’s check-in cursor through the call table');

  const catalog = await ide.post('/call', { channel: IPC.EPIC_TEMPLATES, args: [] });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  const preset = catalog.body.result.find(({ id }: { id: string }) => id === 'implement-review-measure');
  assert.ok(preset?.text);
  const created = await design.post('/create-task', {
    repoId: repo.id,
    machine: 'ide',
    createdByTaskId: 'epic',
    name: 'New epic',
    epic: { goal: brief.goal, template: preset.text, templateId: preset.id },
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.repoId, 'ide-repo');
  assert.equal(created.body.summary, brief.goal);
  assert.equal(created.body.epic.template, preset.text);
  assert.equal(created.body.epic.templateId, preset.id);
  assert.ok(created.body.id);
  console.log('ok — confirmed creation inherits the repository across instance-specific IDs and saves the epic brief');
} finally {
  await Promise.allSettled(cleanups.map((close) => close()));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}
