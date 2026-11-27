/**
 * The restart script finds Bifrost's Electron in ps on macOS and Linux, and stops
 * it at once. Its ps lists sleeping processes of the check's own as Bifrost, so
 * the stop reaches only those. Its PATH of stubs has no npm, seq or sleep, so it
 * starts nothing and its waits end at once. Run with `npm run check:restart-find`.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-restart-find-')));
const home = path.join(root, 'home');
const repo = path.join(root, 'repo');
const other = path.join(root, 'other');
const bin = path.join(root, 'bin');
fs.mkdirSync(path.join(home, '.bifrost', 'restart'), { recursive: true });
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "bifrost"\n}\n');
fs.mkdirSync(other);
fs.writeFileSync(path.join(other, 'package.json'), '{\n  "name": "other"\n}\n');
fs.mkdirSync(bin);
for (const tool of ['awk', 'sed', 'head', 'grep', 'cat', 'date', 'mkdir', 'dirname', 'cp', 'tr', 'wc', 'jq', 'node']) {
  const found = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).trim();
  fs.symlinkSync(found, path.join(bin, tool));
}
// Grants no claim, as when another session holds the cpu.
fs.writeFileSync(path.join(bin, 'headroom'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf-8' }).trim();
const script = path.resolve('scripts/restart-bifrost.sh');

const standIns: ChildProcess[] = [];
/** The pid of a process of the check's own, standing in for Bifrost's Electron or its forge. */
function standIn(): number {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  standIns.push(child);
  return child.pid as number;
}

/** The log of a run that sees these ps lines. */
function runSeeing(psLines: string[], env: Record<string, string> = {}): string {
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ncat <<'EOF'\n${psLines.join('\n')}\nEOF\n`, { mode: 0o755 });
  const ts = `t${Math.random().toString(36).slice(2)}`;
  spawnSync(bash, [script, '--run'], { env: { HOME: home, PATH: bin, RESTART_TS: ts, ...env }, stdio: 'ignore' });
  return fs.readFileSync(path.join(home, '.bifrost', 'restart', `${ts}.log`), 'utf-8');
}

try {
  const found = [`Electron.app/Contents/MacOS/Electron`, `electron`].map((binary) => {
    const electron = standIn();
    return runSeeing([
      `  103 ${electron} ${repo}/node_modules/electron/dist/electron --type=zygote --no-zygote-sandbox`,
      `  ${electron} 100 ${repo}/node_modules/electron/dist/${binary} .`,
    ]).includes(`Bifrost runs from ${repo}\n`);
  });
  check(
    'the Electron of a Bifrost in development mode is found on macOS and on Linux',
    found.every(Boolean),
    String(found),
  );

  const amongOthers = runSeeing([
    `  201 200 ${other}/node_modules/electron/dist/electron .`,
    `  ${standIn()} 100 ${repo}/node_modules/electron/dist/electron .`,
  ]);
  check(
    'the Electron of another app in development mode is passed over',
    amongOthers.includes(`Bifrost runs from ${repo}\n`),
    amongOthers,
  );

  const [electron, forge] = [standIn(), standIn()];
  const parent = runSeeing([
    `  ${forge} 99 /opt/node/bin/node /data/link/node_modules/@electron-forge/cli/dist/electron-forge-start.js`,
    `  ${electron} ${forge} ${repo}/node_modules/electron/dist/electron .`,
  ]);
  check(
    "forge is the parent of Bifrost's Electron, under whatever path",
    parent.includes('node /opt/node/bin/node'),
    parent,
  );
  check(
    'a restart stops Bifrost without waiting for a cpu claim',
    parent.includes(`SIGTERM Electron ${electron} (forge ${forge})`),
    parent,
  );

  const zygoteOnly = runSeeing([`  103 102 ${repo}/node_modules/electron/dist/electron --type=zygote`]);
  check('a Chromium helper process is not taken for Bifrost', zygoteOnly.includes('no Bifrost running'), zygoteOnly);

  const removed = path.join(root, 'removed-worktree');
  fs.mkdirSync(path.join(removed, '.vite'), { recursive: true });
  const orphan = standIn();
  fs.writeFileSync(
    path.join(bin, 'ps'),
    `#!/bin/sh\necho '  ${orphan} 100 ${removed}/node_modules/electron/dist/electron .'\n`,
    {
      mode: 0o755,
    },
  );
  // Launched from the checkout's own copy, as a task runs it. The detached run is a copy elsewhere.
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(script, path.join(repo, 'scripts', 'restart-bifrost.sh'));
  const launchHome = path.join(root, 'launch-home');
  // The launch hands the copy to bash by name.
  fs.symlinkSync(bash, path.join(bin, 'bash'));
  const launched = spawnSync(bash, [path.join(repo, 'scripts', 'restart-bifrost.sh')], {
    env: { HOME: launchHome, PATH: bin },
    encoding: 'utf-8',
  });
  const log = path.join(launchHome, '.bifrost', 'restart', `${/restart\/(\S+)\.log/.exec(launched.stdout)?.[1]}.log`);
  let fromRemoved = '';
  for (let i = 0; i < 100 && !fromRemoved.includes('SIGTERM'); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    fromRemoved = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '';
  }
  check(
    'a Bifrost whose checkout was removed is stopped and started again from the checkout the restart was launched from',
    fromRemoved.includes(`Bifrost runs from ${repo}\n`) && fromRemoved.includes(`SIGTERM Electron ${orphan}`),
    fromRemoved,
  );

  fs.rmSync(path.join(bin, 'jq'));
  const launch = spawnSync(bash, [script], { env: { HOME: home, PATH: bin }, encoding: 'utf-8' });
  check(
    'without jq, the script says so and restarts nothing',
    launch.status === 1 &&
      launch.stderr.includes('jq') &&
      fs.readdirSync(path.join(home, '.bifrost', 'restart')).every((f) => !f.endsWith('.sh')),
    JSON.stringify({ status: launch.status, stderr: launch.stderr }),
  );
} finally {
  for (const child of standIns) child.kill();
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
