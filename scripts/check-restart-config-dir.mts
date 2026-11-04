/**
 * A restart starts Bifrost with the config dir the running one recorded, not
 * the one the calling task was started under. The script runs against a
 * temporary home with a ps that lists no Bifrost, so it stops before touching
 * one. Run with `npm run check:restart-config-dir`.
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

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-restart-')));
const home = path.join(root, 'home');
const stubs = path.join(root, 'stubs');
fs.mkdirSync(path.join(home, '.bifrost', 'restart'), { recursive: true });
fs.mkdirSync(stubs);
fs.writeFileSync(path.join(stubs, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const record = path.join(home, '.bifrost', 'claude-config-dir');

/** The config dir the script would start Bifrost with, as its log says. */
function startsWith(recorded: string | null): string {
  if (recorded === null) fs.rmSync(record, { force: true });
  else fs.writeFileSync(record, recorded);
  const ts = `t${Math.random().toString(36).slice(2)}`;
  try {
    execFileSync('bash', ['scripts/restart-bifrost.sh', '--run'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${stubs}:${process.env.PATH}`,
        RESTART_TS: ts,
        CLAUDE_CONFIG_DIR: '/stale',
      },
      stdio: 'ignore',
    });
  } catch {
    /* it stops, finding no Bifrost */
  }
  const log = fs.readFileSync(path.join(home, '.bifrost', 'restart', `${ts}.log`), 'utf-8');
  return /Claude config dir: (.*)$/m.exec(log)?.[1] ?? log;
}

try {
  const none = startsWith('');
  const work = startsWith('/Users/ann/.claude-work');
  const older = startsWith(null);
  check(
    "a restart starts Bifrost with the config dir the running one recorded, not the calling task's",
    none === 'default' && work === '/Users/ann/.claude-work' && older === '/stale',
    JSON.stringify({ none, work, older }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
