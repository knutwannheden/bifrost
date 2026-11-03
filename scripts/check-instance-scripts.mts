/**
 * The scripts that install, start and probe Bifrost's instance on another
 * machine, run here against a temporary home with a real tmux. A stub npm links
 * this checkout's node_modules in place of an install. Run with
 * `npm run check:instance-scripts`.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pack } from '../src/main/instance-deploy.ts';
import {
  installInstanceScript,
  instanceStatusScript,
  parseScriptOutput,
  relinks,
  startInstanceScript,
} from '../src/main/remote-host.ts';
import { tmuxConf } from '../src/main/tmux-session.ts';

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

const repoRoot = path.resolve(import.meta.dirname, '..');
const packed = await pack(repoRoot);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-instance-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
const failing = path.join(root, 'failing');
const tmp = path.join(root, 'tmp');
for (const dir of [home, stubs, failing, tmp, path.join(home, '.bifrost')]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(stubs, 'claude'), '#!/bin/sh\nprintf "stub\\n"\nexec cat\n', { mode: 0o755 });
fs.writeFileSync(path.join(stubs, 'npm'), `#!/bin/sh\nln -s '${repoRoot}/node_modules' node_modules\n`, {
  mode: 0o755,
});
fs.writeFileSync(path.join(failing, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
fs.writeFileSync(path.join(home, '.bifrost', 'tmux.conf'), tmuxConf());
const socket = path.join(root, `tmux-${process.getuid?.()}`, 'bifrost');
const tmux = (...args: string[]) => execFileSync('tmux', ['-S', socket, ...args], { encoding: 'utf-8' }).trim();
const portFile = path.join(home, '.bifrost', 'instance-port');
const apiPortFile = path.join(home, '.bifrost', 'api-port');
const panePid = (session: string) => tmux('list-panes', '-t', `=${session}`, '-F', '#{pane_pid}');

function env(first: string): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMPDIR: tmp, TMUX_TMPDIR: root };
  e.PATH = `${first}:${stubs}:${process.env.PATH}`;
  // A login shell that is not POSIX sh must not matter to what tmux runs.
  if (fs.existsSync('/bin/csh')) e.SHELL = '/bin/csh';
  delete e.CLAUDE_CONFIG_DIR;
  delete e.TMUX;
  return e;
}
function run(script: string, first = stubs): Record<string, string> {
  return parseScriptOutput(
    execFileSync('sh', ['-s'], { input: script, cwd: home, env: env(first), encoding: 'utf-8' }),
  );
}
function unpack(): void {
  const dest = path.join(home, '.bifrost', 'instance.new');
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest);
  for (const name of ['headless.js', 'package.json'])
    fs.copyFileSync(path.join(packed.dir, name), path.join(dest, name));
}
async function answers(port: string | undefined): Promise<boolean> {
  if (!port) return false;
  const res = await fetch(`http://127.0.0.1:${port}/list-tasks`, {
    method: 'POST',
    body: '{}',
    signal: AbortSignal.timeout(5_000),
  }).catch(() => undefined);
  return res?.status === 200;
}
const alive = (pid: string) => {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

check(
  'only a session keeps reconnecting a dropped connection, while the instance waits for its next use',
  relinks(new Set(['instance', 'task-1'])) && !relinks(new Set(['instance'])) && !relinks(new Set()),
);

// What api-port names until the switch: the IDE's own API, forwarded, which answers like an instance.
// It runs in a process of its own, since the scripts run synchronously here.
const decoy = spawn(process.execPath, [
  '-e',
  `require('node:http').createServer((q, r) => r.end('{"tasks":[]}')).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`,
]);
const decoyPort = await new Promise<string>((resolve) => decoy.stdout.once('data', (d) => resolve(String(d).trim())));

try {
  let port: string | undefined;
  {
    fs.writeFileSync(apiPortFile, decoyPort);
    unpack();
    run(installInstanceScript(packed.hash));
    const before = run(instanceStatusScript());
    port = run(startInstanceScript('perf')).INSTANCE_PORT;
    check(
      'an installed instance starts in tmux and answers, and another API on api-port is not taken for it',
      before.INSTANCE_HASH === packed.hash &&
        before.INSTANCE_PORT === undefined &&
        port !== decoyPort &&
        (await answers(port)),
      show({ before, port, decoyPort }),
    );
  }

  {
    const runSh = path.join(home, '.bifrost', 'sessions', 'console', 'run.sh');
    await until(() => fs.existsSync(runSh), 10_000);
    const text = fs.existsSync(runSh) ? fs.readFileSync(runSh, 'utf-8') : '';
    check(
      "an instance on another machine starts its sessions with the plugin and that machine's name",
      text.includes('--plugin-dir') &&
        text.includes(path.join(home, '.bifrost', 'claude-plugin')) &&
        /BIFROST_MACHINE=.?perf/.test(text),
      text,
    );
  }

  {
    await until(() => {
      try {
        tmux('has-session', '-t', '=console');
        return true;
      } catch {
        return false;
      }
    }, 10_000);
    const consolePid = panePid('console');
    const loopPid = panePid('instance');
    // tmux hangs the instance up when it kills its session, which a clean stop answers by giving up its port.
    tmux('kill-session', '-t', '=instance');
    const stoppedCleanly = await until(() => !fs.existsSync(portFile), 3_000);
    port = run(startInstanceScript('perf')).INSTANCE_PORT;
    const restarted = await answers(port);
    check(
      'starting it again restarts it and leaves the other sessions running',
      stoppedCleanly && restarted && !alive(loopPid) && panePid('console') === consolePid,
      show({ stoppedCleanly, restarted, loopPid, loopAlive: alive(loopPid), consolePid }),
    );
  }

  {
    unpack();
    let refused = false;
    try {
      run(installInstanceScript('other'), failing);
    } catch {
      refused = true;
    }
    const after = run(instanceStatusScript());
    check(
      'a failed install leaves the running instance as it was',
      refused && after.INSTANCE_HASH === packed.hash && after.INSTANCE_PORT === port && (await answers(port)),
      show({ refused, after, port }),
    );
  }
} finally {
  decoy.kill();
  try {
    execFileSync('tmux', ['-S', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* a server with no sessions has already exited */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
