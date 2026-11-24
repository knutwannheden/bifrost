/**
 * A prompt sent to a session is typed the way an agent's input takes it, and
 * is seen to be submitted. Runs a headless instance under a temporary home with
 * a stub agent that draws an input line and records what it reads. Run with
 * `npm run check:send-prompt`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-send-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const tmp = path.join(root, 'tmp');
const repo = path.join(root, 'repo');
for (const dir of [path.join(home, '.bifrost'), stubs, tmp, repo]) fs.mkdirSync(dir, { recursive: true });
const record = path.join(root, 'record.jsonl');
const modeFile = path.join(root, 'mode');

// An input box like Claude's: what has been typed after ❯, between two rules. "swallow"
// ignores Enter, and "suggest" draws a faint suggestion while nothing is typed.
fs.writeFileSync(
  path.join(stubs, 'claude'),
  `#!/usr/bin/env node
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const note = (entry) => fs.appendFileSync(${show(record)}, JSON.stringify({ t: Date.now(), ...entry }) + '\\n');
const mode = () => { try { return fs.readFileSync(${show(modeFile)}, 'utf8').trim(); } catch { return 'submit'; } };
let input = '';
let escape = false;
const draw = () => {
  const faint = mode() === 'suggest' && input === '' ? '\\x1b[2mtry the suggestion\\x1b[0m' : '';
  const [first, ...rest] = input.split('\\n');
  const more = rest.map((line) => '\\r\\n  ' + line).join('');
  process.stdout.write('\\x1b[2J\\x1b[H────────\\r\\n❯ ' + first + faint + more + '\\r\\n────────');
};
const decoder = new StringDecoder('utf8');
process.stdin.setRawMode(true);
process.stdin.on('data', (chunk) => {
  const text = decoder.write(chunk);
  note({ read: text });
  for (const ch of text) {
    if (escape) {
      escape = false;
      if (ch === '\\x7f') input = input.replace(/\\S*\\s*$/, '');
    } else if (ch === '\\x1b') escape = true;
    else if (ch === '\\r') {
      if (mode() === 'swallow') note({ swallowed: input });
      else { note({ submitted: input }); input = ''; }
    } else if (ch === '\\x15') input = '';
    else if (ch >= ' ' || ch === '\\n') input += ch;
  }
  draw();
});
draw();
note({ ready: true });
`,
  { mode: 0o755 },
);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
// Codex's session draws the same input box, and `codex queue` records what it was handed.
fs.writeFileSync(
  path.join(stubs, 'codex'),
  `#!/usr/bin/env node
if (process.argv[2] === 'queue') {
  require('fs').appendFileSync(${show(record)}, JSON.stringify({ queue: process.argv.slice(3) }) + '\\n');
} else {
  require(${show(path.join(stubs, 'claude'))});
}
`,
  { mode: 0o755 },
);
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
const post = async (route: string, body: unknown) =>
  (await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json())) as Record<string, unknown>;
const entries = (): Array<Record<string, unknown>> =>
  fs.existsSync(record)
    ? fs
        .readFileSync(record, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
async function until(condition: () => boolean, ms = 10_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (condition()) return true;
  return condition();
}
/** A text long enough for several pieces, with a three-byte character where a byte-split would cut it. */
const prompt = (tag: string) =>
  `${'x'.repeat(127)}—${tag}\n\n${`A line of the ${tag} prompt with \`code\`. `.repeat(20)}`;

try {
  fs.rmSync(portFile, { force: true });
  instance = spawn('node', ['.vite/headless/headless.js'], { env, stdio: 'ignore' });
  for (const end = Date.now() + 15_000; !fs.existsSync(portFile) && Date.now() < end; ) await sleep(50);
  port = fs.readFileSync(portFile, 'utf8').trim();
  const task = (await post('/create-task', { repoPath: repo, name: 'prompts' })) as Task;
  await until(() => entries().some((e) => e.ready));
  const send = (text: string, mode = 'direct') => post('/send-prompt', { taskId: task.id, text, mode });
  const since = (from: number) => entries().slice(from);
  const hook = (event: string) =>
    post('/hook', {
      hook_event_name: event,
      cwd: task.worktreePath,
      bifrost_task_id: task.id,
      bifrost_context: 'code',
    });

  {
    const from = entries().length;
    const text = prompt('paced');
    const result = await send(text);
    const got = since(from);
    const reads = got.filter((e) => typeof e.read === 'string') as Array<{ t: number; read: string }>;
    const enter = reads.findIndex((e) => e.read.includes('\r'));
    const gap = enter > 0 ? reads[enter].t - reads[enter - 1].t : 0;
    check(
      'a prompt is typed in pieces and submitted whole by an Enter that follows a pause',
      result.ok === true && got.find((e) => 'submitted' in e)?.submitted === text && enter >= 4 && gap >= 400,
      show({ result, reads: reads.length, enter, gap, submitted: got.find((e) => 'submitted' in e) }),
    );
  }

  {
    const keys = (...args: string[]) =>
      execFileSync('tmux', ['-S', socket, 'send-keys', '-t', `=${task.id}:`, ...args], { stdio: 'ignore' });
    keys('-l', 'my draft');
    keys('C-j');
    keys('-l', 'second line');
    await until(() => entries().some((e) => e.read === 'second line'));
    const from = entries().length;
    await send(prompt('drafted'));
    await sleep(300);
    const kept = since(from);
    const restored = kept
      .filter((e) => typeof e.read === 'string')
      .map((e) => e.read)
      .join('')
      .endsWith('my draft\nsecond line');

    keys('C-u');
    fs.writeFileSync(modeFile, 'suggest');
    await sleep(300);
    const at = entries().length;
    await send(prompt('suggested'));
    await sleep(300);
    const after = since(at);
    const typed = after
      .filter((e) => typeof e.read === 'string')
      .map((e) => e.read)
      .join('');
    check(
      'a typed draft of two lines is set aside and typed again after the prompt, and a faint suggestion is left alone',
      kept.find((e) => 'submitted' in e)?.submitted === prompt('drafted') &&
        restored &&
        after.find((e) => 'submitted' in e)?.submitted === prompt('suggested') &&
        !typed.includes('\x1b\x7f') &&
        !typed.includes('suggestion'),
      show({ kept: kept.find((e) => 'submitted' in e), restored, after: after.find((e) => 'submitted' in e) }),
    );
    fs.writeFileSync(modeFile, 'submit');
  }

  {
    await hook('UserPromptSubmit');
    const from = entries().length;
    const started = Date.now();
    const pending = send(prompt('queued'), 'queue');
    const answered = await Promise.race([pending.then(() => true), sleep(3000).then(() => false)]);
    const early = { answered, ms: Date.now() - started, typed: since(from).length };
    await hook('Stop');
    const result = await pending;
    await until(() => since(from).some((e) => 'submitted' in e));
    check(
      'a prompt for a task mid-turn is queued at once, and typed when the turn ends',
      answered &&
        result.queued === true &&
        early.typed === 0 &&
        since(from).find((e) => 'submitted' in e)?.submitted === prompt('queued'),
      show({ early, result, submitted: since(from).find((e) => 'submitted' in e) }),
    );
  }

  {
    const codex = (await post('/create-task', {
      repoPath: repo,
      name: 'codex prompts',
      launch: { agent: 'codex' },
    })) as Task;
    await post('/session-start', {
      session_id: 'codex-thread',
      source: 'startup',
      cwd: codex.worktreePath,
      bifrost_task_id: codex.id,
      bifrost_context: 'code',
    });
    await post('/hook', {
      hook_event_name: 'UserPromptSubmit',
      cwd: codex.worktreePath,
      bifrost_task_id: codex.id,
      bifrost_context: 'code',
    });
    const from = entries().length;
    const result = await post('/message-task', { taskId: codex.id, text: prompt('codex') });
    await sleep(300);
    const queued = since(from).find((e) => 'queue' in e)?.queue as string[] | undefined;
    check(
      "a message for a Codex task mid-turn goes to Codex's own queue for its thread, and nothing is typed",
      result.queued === true &&
        queued?.slice(0, 2).join(' ') === '--thread codex-thread' &&
        String(queued[2]).startsWith('--message=From ') &&
        String(queued[2]).includes(prompt('codex')) &&
        !since(from).some((e) => typeof e.read === 'string'),
      show({ result, queued: queued?.slice(0, 2), reads: since(from).filter((e) => 'read' in e).length }),
    );

    await post('/hook', {
      hook_event_name: 'Interrupt',
      cwd: codex.worktreePath,
      bifrost_task_id: codex.id,
      bifrost_context: 'code',
    });
    const at = entries().length;
    const typed = await post('/message-task', { taskId: codex.id, text: prompt('interrupted') });
    await until(() => since(at).some((e) => 'submitted' in e));
    check(
      'after the user interrupts a Codex turn, which holds its queue until the next prompt, a message is typed',
      typed.ok === true &&
        !since(at).some((e) => 'queue' in e) &&
        String(since(at).find((e) => 'submitted' in e)?.submitted).includes(prompt('interrupted')),
      show({ typed, queued: since(at).some((e) => 'queue' in e) }),
    );
  }

  {
    fs.writeFileSync(modeFile, 'swallow');
    const from = entries().length;
    const result = await send(prompt('swallowed'));
    const enters = since(from).filter((e) => 'swallowed' in e).length;
    check(
      'an Enter the agent does not take is pressed twice more, then the send fails',
      result.ok === false && enters === 3 && /not submitted/.test(String(result.error)),
      show({ result, enters }),
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
