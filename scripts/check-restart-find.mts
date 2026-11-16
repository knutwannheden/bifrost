/**
 * The restart script finds Bifrost's Electron in ps on macOS and Linux. It runs
 * with a PATH of stubs whose headroom grants no claim, so it never stops a
 * Bifrost. Run with `npm run check:restart-find`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
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
const bin = path.join(root, 'bin');
fs.mkdirSync(path.join(home, '.bifrost', 'restart'), { recursive: true });
fs.mkdirSync(repo);
fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "name": "bifrost"\n}\n');
fs.mkdirSync(bin);
for (const tool of [
  'awk',
  'sed',
  'head',
  'grep',
  'cat',
  'date',
  'mkdir',
  'dirname',
  'cp',
  'tr',
  'wc',
  'jq',
  'python3',
]) {
  const found = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf-8' }).trim();
  fs.symlinkSync(found, path.join(bin, tool));
}
fs.writeFileSync(path.join(bin, 'headroom'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const bash = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf-8' }).trim();
const script = path.resolve('scripts/restart-bifrost.sh');

/** The log of a run that sees these ps lines. */
function runSeeing(psLines: string[]): string {
  fs.writeFileSync(path.join(bin, 'ps'), `#!/bin/sh\ncat <<'EOF'\n${psLines.join('\n')}\nEOF\n`, { mode: 0o755 });
  const ts = `t${Math.random().toString(36).slice(2)}`;
  spawnSync(bash, [script, '--run'], { env: { HOME: home, PATH: bin, RESTART_TS: ts }, stdio: 'ignore' });
  return fs.readFileSync(path.join(home, '.bifrost', 'restart', `${ts}.log`), 'utf-8');
}

try {
  const found = [
    `  101 ${repo}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .`,
    `  102 ${repo}/node_modules/electron/dist/electron .`,
  ].map((line) =>
    runSeeing([`  103 ${repo}/node_modules/electron/dist/electron --type=zygote --no-zygote-sandbox`, line]).includes(
      `Bifrost runs from ${repo}\n`,
    ),
  );
  check(
    'the Electron of a Bifrost in development mode is found on macOS and on Linux',
    found.every(Boolean),
    String(found),
  );

  const zygoteOnly = runSeeing([`  103 ${repo}/node_modules/electron/dist/electron --type=zygote`]);
  check('a Chromium helper process is not taken for Bifrost', zygoteOnly.includes('no Bifrost running'), zygoteOnly);

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
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
