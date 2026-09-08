/**
 * Seeding trust writes into Claude Code's own config, so it has to add its one
 * key and disturb nothing else. Run with `npm run check:trust`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { trustDirectory } from '../src/main/claude-trust.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-trust-')));
const configPath = path.join(root, 'claude.json');
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

const write = (data: unknown) => fs.writeFileSync(configPath, JSON.stringify(data, null, 2));
const read = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));

write({ numStartups: 7, projects: {} });
trustDirectory(repo, configPath);
check(
  'a directory Claude has never seen gets a trusted entry',
  read().projects[repo]?.hasTrustDialogAccepted === true && read().numStartups === 7,
);

write({ projects: { [repo]: { hasTrustDialogAccepted: false, lastSessionId: 'abc', lastCost: 1.5 } } });
trustDirectory(repo, configPath);
{
  const entry = read().projects[repo];
  check(
    'an existing entry keeps everything but the flag',
    entry.hasTrustDialogAccepted === true && entry.lastSessionId === 'abc' && entry.lastCost === 1.5,
  );
}

write({ projects: { [repo]: { hasTrustDialogAccepted: true } } });
{
  const before = fs.readFileSync(configPath, 'utf-8');
  const wrote = trustDirectory(repo, configPath);
  check(
    'a directory already trusted is not rewritten',
    wrote === false && fs.readFileSync(configPath, 'utf-8') === before,
  );
}

// /var is a symlink to /private/var on macOS, and Claude looks the project up
// under the path it resolved.
{
  const link = path.join(root, 'link-to-repo');
  fs.symlinkSync(repo, link);
  write({ projects: {} });
  trustDirectory(link, configPath);
  check('a symlinked directory is recorded under the path Claude resolves', read().projects[repo] !== undefined);
}

{
  fs.writeFileSync(configPath, '{ this is not json');
  const wrote = trustDirectory(repo, configPath);
  check(
    'a config that cannot be read is left alone',
    wrote === false && fs.readFileSync(configPath, 'utf-8') === '{ this is not json',
  );
}

check('no config at all is nothing to do', trustDirectory(repo, path.join(root, 'absent.json')) === false);

fs.rmSync(root, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
