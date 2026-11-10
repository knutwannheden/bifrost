/**
 * A session's run.sh starts whichever agent its machine runs, resuming that
 * agent's conversation when it has one. These run run.sh under a temporary
 * home with stub `copilot` and `codex` that record what reached them. Run with
 * `npm run check:agent-sessions`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-agents-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const record = path.join(root, 'record');
const worktree = path.join(root, 'worktree');
for (const dir of [home, stubs, record, worktree]) fs.mkdirSync(dir);
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.COPILOT_HOME;
delete process.env.CODEX_HOME;

const { writeLocalSession, sessionDir } = await import('../src/main/tmux-session.ts');

for (const agent of ['copilot', 'codex']) {
  fs.writeFileSync(path.join(stubs, agent), `#!/bin/sh\nprintf '%s\\0' "$@" > '${record}/${agent}'\n`, { mode: 0o755 });
}

const prompt = `Fix the build.\nIt's "broken" since $(touch "$HOME/injected") and \`id\`.\n-n leads a line.`;

function start(agent: string): string[] {
  fs.rmSync(path.join(record, agent), { force: true });
  execFileSync('sh', [path.join(home, sessionDir('t-agent'), 'run.sh')], {
    env: { ...process.env, HOME: home, PATH: `${stubs}:${process.env.PATH}` },
    stdio: 'pipe',
  });
  return fs.readFileSync(path.join(record, agent), 'utf-8').split('\0').slice(0, -1);
}

const sid = '0b8e2f34-0000-4000-8000-000000000001';
const setUp = (agent: 'copilot' | 'codex', sessionId: string, withPrompt = true) =>
  writeLocalSession({
    home,
    taskId: 't-agent',
    worktreePath: worktree,
    agent,
    sessionId,
    args: ['--flag', 'value with spaces'],
    env: {},
    ...(withPrompt ? { prompt } : {}),
  });

setUp('copilot', sid);
check(
  'Copilot starts under the session id Bifrost chose, with the prompt intact and none of it run',
  show(start('copilot')) === show(['--flag', 'value with spaces', '--session-id', sid, '-i', prompt]) &&
    !fs.existsSync(path.join(home, 'injected')),
);
check(
  'a later Copilot start does not send the prompt again',
  show(start('copilot')) === show(['--flag', 'value with spaces', '--session-id', sid]),
);
fs.mkdirSync(path.join(home, '.copilot', 'session-state', sid), { recursive: true });
setUp('copilot', sid);
check(
  'a Copilot session that has a transcript resumes under its id without the prompt',
  show(start('copilot')) === show(['--flag', 'value with spaces', '--session-id', sid]),
);

const trusted = (dir: string) => ['-c', `projects={"${dir}"={trust_level="trusted"}}`];
setUp('codex', '');
check(
  'Codex, which picks its own id, starts with the prompt as its argument',
  show(start('codex')) === show([...trusted(worktree), '--flag', 'value with spaces', '--', prompt]),
);
setUp('codex', sid, false);
check(
  'a Codex session whose id is known but has no transcript starts afresh',
  show(start('codex')) === show([...trusted(worktree), '--flag', 'value with spaces']),
);
const day = path.join(home, '.codex', 'sessions', '2026', '11', '10');
fs.mkdirSync(day, { recursive: true });
fs.writeFileSync(path.join(day, `rollout-2026-11-10T00-00-00-${sid}.jsonl`), '{}\n');
setUp('codex', sid);
check(
  'a Codex session with a transcript resumes it by id without the prompt',
  show(start('codex')) === show(['resume', ...trusted(worktree), '--flag', 'value with spaces', sid]),
);

{
  const main = path.join(root, 'main');
  const linked = path.join(main, '.worktrees', 'linked');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: main, stdio: 'pipe' });
  fs.mkdirSync(main);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', linked);
  writeLocalSession({
    home,
    taskId: 't-agent',
    worktreePath: linked,
    agent: 'codex',
    sessionId: '',
    args: [],
    env: {},
  });
  check(
    'Codex in a worktree is told its main checkout is trusted, which is where it looks',
    show(start('codex').slice(0, 2)) === show(trusted(main)),
  );
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
