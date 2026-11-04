/**
 * Seeding trust writes into Claude Code's own config, so it has to add its one
 * key and disturb nothing else. Run with `npm run check:trust`.
 */
import { execFileSync } from 'node:child_process';
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

/**
 * Starts the installed Claude in dir, with this check's config as its own, and
 * answers whether it stops to ask for trust. Undefined without claude or tmux.
 */
function claudeAsksForTrust(dir: string): boolean | undefined {
  let version: string;
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    version = execFileSync('claude', ['--version'], { encoding: 'utf-8' }).split(' ')[0];
  } catch {
    return undefined;
  }
  const home = path.join(root, 'claude-home');
  fs.mkdirSync(home, { recursive: true });
  const config = { ...read(), hasCompletedOnboarding: true, lastOnboardingVersion: version, theme: 'dark' };
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(config));
  const tmux = (...args: string[]) =>
    execFileSync('tmux', ['-L', `bifrost-trust-${process.pid}`, ...args], { encoding: 'utf-8' });
  const env = `env -i HOME='${home}' PATH='${process.env.PATH}' TERM=xterm-256color USER='${process.env.USER}' LANG=en_US.UTF-8`;
  tmux('new-session', '-d', '-s', 'claude', '-x', '120', '-y', '30', `cd '${dir}' && ${env} claude`);
  try {
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      const screen = tmux('capture-pane', '-p', '-t', '=claude:');
      if (screen.includes('Accessing workspace')) return true;
      // The prompt's footer, which the trust question does not show.
      if (screen.includes('shift+tab')) return false;
      execFileSync('sleep', ['0.2']);
    }
    return undefined;
  } finally {
    tmux('kill-server');
  }
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

write({ projects: { [root]: { hasTrustDialogAccepted: true } } });
trustDirectory(repo, configPath);
check(
  'trust on a directory above the repository does not count, so the repository is trusted itself',
  read().projects[repo]?.hasTrustDialogAccepted === true,
);

{
  const main = path.join(root, 'main');
  const worktree = path.join(main, '.worktrees', 'task');
  // Claude asks for trust in a repository whose settings pre-approve a command.
  fs.mkdirSync(path.join(main, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(main, '.claude', 'settings.json'), '{"permissions":{"allow":["Bash(git status:*)"]}}');
  execFileSync('sh', ['-c', 'git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -q -m init'], {
    cwd: main,
  });
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'task', worktree]);
  write({ projects: {} });
  trustDirectory(worktree, configPath);
  const keyed = read().projects[main]?.hasTrustDialogAccepted === true;
  const asked = claudeAsksForTrust(worktree);
  if (asked === undefined) console.log('  (Claude not started: no claude or tmux, or no screen within 20 s)');
  check(
    'a git worktree is trusted under its main repository, and Claude starts there without asking',
    keyed && asked !== true,
    JSON.stringify({ projects: read().projects, asked }),
  );
}

{
  const configDir = path.join(root, 'config-dir');
  fs.mkdirSync(configDir);
  const inDir = path.join(configDir, '.claude.json');
  fs.writeFileSync(inDir, JSON.stringify({ projects: {} }));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  trustDirectory(repo);
  delete process.env.CLAUDE_CONFIG_DIR;
  check(
    'with CLAUDE_CONFIG_DIR set, trust goes to the config Claude reads there',
    JSON.parse(fs.readFileSync(inDir, 'utf-8')).projects[repo]?.hasTrustDialogAccepted === true,
  );
}

// Claude may still be writing its home as it exits.
fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
process.exit(failed === 0 ? 0 : 1);
