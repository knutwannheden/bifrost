/**
 * A tab reads a session through a tmux control-mode client. What it shows must
 * be the program's own bytes, and a client joining a running session must
 * pick up exactly where the replay of its screen ends. These run a real tmux
 * on a server of their own. Run with `npm run check:tmux-control`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import headless from '@xterm/headless';
import { TmuxControl } from '../src/main/tmux-control.ts';

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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-tmux-')));
const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: root };
delete env.TMUX;
const conf = path.join(root, 'tmux.conf');
fs.writeFileSync(conf, 'set -g status off\nset -g history-limit 50000\n');
const tmux = (...args: string[]) => execFileSync('tmux', ['-L', 'check', ...args], { env, stdio: 'pipe' });
const alive = (name: string) => {
  try {
    tmux('has-session', '-t', `=${name}`);
    return true;
  } catch {
    return false;
  }
};

/**
 * A client on the session, which is created running the program when it is
 * missing. A delay holds the client's commands back while it already receives
 * output, as a slow SSH link does.
 */
function attach(name: string, program: string, options: { delay?: number } = {}) {
  const cols = 80;
  const rows = 10;
  const args = ['-L', 'check', '-f', conf, '-C', 'new-session', '-A', '-s', name, '-x', `${cols}`, '-y', `${rows}`];
  args.push('sh', '-c', program);
  const control = options.delay
    ? TmuxControl.start('sh', ['-c', `(sleep ${options.delay}; cat) | tmux "$@"`, 'sh', ...args], { cols, rows }, env)
    : TmuxControl.start('tmux', args, { cols, rows }, env);
  let output = '';
  control.onOutput((data) => {
    output += data;
  });
  let exits = 0;
  const exited = new Promise<void>((resolve) =>
    control.onExit(() => {
      exits++;
      resolve();
    }),
  );
  return { control, output: () => output, exits: () => exits, exited };
}

async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
}

/** The lines a terminal of this size displays, scrollback first, after being written these chunks. */
async function render(chunks: string[], cols = 80, rows = 10) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  for (const chunk of chunks) await new Promise<void>((r) => term.write(chunk, r));
  return term;
}
function lines(term: InstanceType<typeof Terminal>): string[] {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)?.translateToString(true) ?? '');
  return out;
}

try {
  {
    const printed = 'héllo \x1b[31mred\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\';
    const program = `sleep 0.3; printf 'h\\303\\251llo \\033[31mred\\033[0m \\033]8;;https://example.com\\033\\\\link\\033]8;;\\033\\\\'; sleep 5`;
    const s = attach('bytes', program);
    await s.control.screen;
    const arrived = await until(() => s.output().includes(printed));
    check("the client receives the pane's bytes exactly", arrived, show(s.output()));
    s.control.kill();
    await s.exited;
  }

  {
    const s = attach('input', `read -r x; printf 'got:%s\\n' "$x"; sleep 5`);
    await s.control.screen;
    s.control.write('aé\\b\r');
    const arrived = await until(() => s.output().includes('got:aé\\b'));
    check('input reaches the program intact', arrived, show(s.output()));
    s.control.kill();
    await s.exited;
  }

  {
    const program = `i=0; while :; do i=$((i+1)); printf 'n%d\\n' $i; sleep 0.005; done`;
    const first = attach('busy', program);
    await first.control.screen;
    await sleep(300);
    first.control.detach();
    await first.exited;
    const second = attach('busy', program, { delay: 0.3 });
    const replay = await second.control.screen;
    await sleep(300);
    const term = await render([replay, second.output()]);
    const numbers = lines(term)
      .map((line) => /^n(\d+)$/.exec(line)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number);
    const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
    check(
      'a client joining a busy session shows every line once',
      numbers.length > 40 && numbers[0] === 1 && consecutive,
      show(numbers),
    );
    second.control.kill();
    second.control.detach();
    await second.exited;
  }

  {
    const program = `printf 'normal-1\\nnormal-2\\nnormal-3\\n'; printf '\\033[?1049h'; printf 'alt-screen'; sleep 5`;
    const first = attach('alternate', program);
    await first.control.screen;
    await sleep(300);
    first.control.detach();
    await first.exited;
    const second = attach('alternate', program);
    const term = await render([await second.control.screen]);
    const onAlternate = term.buffer.active.type === 'alternate' && lines(term).some((l) => l === 'alt-screen');
    await new Promise<void>((r) => term.write('\x1b[?1049l', r));
    const normal = lines(term);
    check(
      'a session on the alternate screen comes back on it',
      onAlternate && normal.includes('normal-1') && normal.includes('normal-3'),
      show(normal),
    );

    second.control.resize(90, 15);
    const size = await second.control.command("display -p '#{pane_width}x#{pane_height}'");
    check('resizing sets the pane size', show(size) === show(['90x15']), show(size));
    second.control.kill();
    await second.exited;
  }

  {
    const first = attach('lifetime', 'sleep 5');
    await first.control.screen;
    first.control.detach();
    await first.exited;
    const survived = alive('lifetime');
    const second = attach('lifetime', 'sleep 5');
    await second.control.screen;
    second.control.kill();
    await second.exited;
    await sleep(100);
    check(
      'detaching leaves the session running and ending it ends the client',
      survived && !alive('lifetime') && second.exits() === 1,
      show({ survived, alive: alive('lifetime'), exits: second.exits() }),
    );
  }
} finally {
  try {
    tmux('kill-server');
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
