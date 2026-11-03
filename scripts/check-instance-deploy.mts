/**
 * The IDE packs the headless instance for another machine, and from what that
 * machine reports decides whether to install it, start it or leave it be.
 * Run with `npm run check:instance-deploy`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashOf, pack, plan } from '../src/main/instance-deploy.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);
const repoRoot = path.resolve(import.meta.dirname, '..');

{
  const answers = [
    plan({}, 'h'),
    plan({ hash: 'h' }, 'h'),
    plan({ hash: 'h', port: 1 }, 'h'),
    plan({ hash: 'old', port: 1 }, 'h'),
  ];
  check(
    'a machine whose build differs installs, a stopped one starts, a current running one is left alone',
    show(answers) === show(['install', 'start', 'none', 'install']),
    show(answers),
  );
}

{
  const a = await pack(repoRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(a.dir, 'package.json'), 'utf-8'));
  const again = await pack(repoRoot);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-pack-'));
  for (const name of ['headless.js', 'package.json']) fs.copyFileSync(path.join(a.dir, name), path.join(copy, name));
  fs.appendFileSync(path.join(copy, 'package.json'), ' ');
  const changed = hashOf(copy);
  fs.rmSync(copy, { recursive: true, force: true });
  check(
    'the packed instance names its native module, and its hash follows its content',
    typeof manifest.dependencies?.['@parcel/watcher'] === 'string' && again.hash === a.hash && changed !== a.hash,
    show({ manifest, a: a.hash, again: again.hash, changed }),
  );
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
