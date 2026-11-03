/**
 * A cached connection to a machine follows the machine's settings as they
 * change. Run with `npm run check:remote-host`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-remote-host-'));
// config.ts fixes its path as it loads.
process.env.HOME = home;
fs.mkdirSync(path.join(home, '.bifrost'));
const configFile = path.join(home, '.bifrost', 'config.json');
const writeMachines = (machines: unknown) => fs.writeFileSync(configFile, JSON.stringify({ machines }));
const { getRemoteHost } = await import('../src/main/remote-host.ts');

try {
  writeMachines([{ name: 'perf', host: 'perf.example' }]);
  const before = getRemoteHost('perf');
  writeMachines([{ name: 'perf', host: 'perf.example', instance: true }]);
  const after = getRemoteHost('perf');
  check(
    "a cached connection sees a machine's setting turned on since",
    after === before && after.machine.instance === true,
    JSON.stringify({ same: after === before, machine: after.machine }),
  );
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
