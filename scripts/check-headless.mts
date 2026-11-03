/**
 * A Bifrost instance runs under plain Node, with no window. This builds the
 * headless entry and runs it under a temporary home, tmp and tmux server, with
 * a stub `claude`. Run with `npm run check:headless`.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-headless-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const tmp = path.join(root, 'tmp');
for (const dir of [home, stubs, tmp]) fs.mkdirSync(dir);
fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\nprintf "stub\\n"\nexec cat\n', { mode: 0o755 });
// The instance's tmp is its own, since starting the change feed empties a directory there.
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, TMUX_TMPDIR: root };
env.PATH = `${stubs}:${process.env.PATH}`;
delete env.CLAUDE_CONFIG_DIR;
delete env.TMUX;
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');
const consoleRuns = () => {
  try {
    execFileSync('tmux', ['-S', socket, 'has-session', '-t', '=console'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

let child: ChildProcess | undefined;
let output = '';
try {
  child = spawn('node', ['.vite/headless/headless.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
  const exited = new Promise<number | null>((resolve) => child?.on('exit', (code) => resolve(code)));

  {
    const portFile = path.join(home, '.bifrost', 'api-port');
    const up = await until(() => fs.existsSync(portFile), 15_000);
    let answer: { status: number; list?: { tasks: unknown[] } } = { status: 0 };
    if (up) {
      const res = await fetch(`http://127.0.0.1:${fs.readFileSync(portFile, 'utf8').trim()}/list-tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      answer = { status: res.status, list: await res.json() };
    }
    check(
      'an instance comes up without Electron and serves its API',
      answer.status === 200 && answer.list?.tasks.length === 0,
      show({ up, answer, output: output.slice(-800) }),
    );
  }

  {
    const ran = await until(consoleRuns, 10_000);
    child.kill('SIGTERM');
    const code = await Promise.race([exited, sleep(10_000).then(() => 'timeout')]);
    check(
      'stopping an instance leaves its sessions running',
      ran && code === 0 && consoleRuns(),
      show({ ran, code, still: consoleRuns(), output: output.slice(-800) }),
    );
  }
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
