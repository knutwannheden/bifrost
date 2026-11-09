/**
 * A machine keeps the Claude paths of the dotfiles repo in a clone of its own,
 * which Bifrost fast-forwards on every connect, as it does the repo here. It
 * runs between local home directories, with a bare repository standing in for
 * the one both clone. Run with `npm run check:dotfiles`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncDotfiles } from '../src/main/dotfiles.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

// Whoever runs this check has a git setup of their own, which must not sign or hook these commits.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'check',
  GIT_AUTHOR_EMAIL: 'check@example.com',
  GIT_COMMITTER_NAME: 'check',
  GIT_COMMITTER_EMAIL: 'check@example.com',
});

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-dotfiles-')));
const origin = path.join(root, 'origin.git');
const here = path.join(root, 'here');
const there = path.join(root, 'there');
const other = path.join(root, 'other');
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
/** git on a home directory whose repository is ~/.dotfiles, as the dotfiles repo is laid out. */
const dot = (home: string, ...args: string[]) =>
  execFileSync('git', [`--git-dir=${home}/.dotfiles`, `--work-tree=${home}`, ...args], { cwd: home })
    .toString()
    .trim();
const commit = (home: string, message: string, ...paths: string[]) => {
  dot(home, 'add', '-f', ...paths);
  dot(home, 'commit', '-q', '-m', message);
  dot(home, 'push', '-q', 'origin', 'HEAD');
};

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', `${here}/.dotfiles`]);
dot(here, 'remote', 'add', 'origin', origin);
dot(here, 'config', 'core.excludesfile', `${here}/.dotfiles-gitignore`);
write(
  `${here}/.dotfiles-gitignore`,
  '*\n!.zshrc\n!.claude/\n.claude/*\n!.claude/skills/\n!.claude/skills/**\n.claude/skills/synced/\n',
);
write(`${here}/.zshrc`, 'zshrc here\n');
write(`${here}/.claude/skills/a/SKILL.md`, 'a, first\n');
write(`${here}/.claude/skills/b/SKILL.md`, 'b, first\n');
write(`${here}/.claude/agents/helper.md`, 'helper\n');
commit(here, 'one', '.dotfiles-gitignore', '.zshrc', '.claude/skills', '.claude/agents');
dot(here, 'branch', '--set-upstream-to=origin/main');

// The machine has its own .zshrc, and the copy an earlier sync left of the skills, one of them edited there.
write(`${there}/.zshrc`, 'zshrc there\n');
write(`${there}/.claude/skills/a/SKILL.md`, 'a, edited there\n');
write(`${there}/.claude/skills/synced/x.md`, 'synced from claude.ai\n');
const machine = async (script: string) =>
  execFileSync('sh', ['-s'], { cwd: there, input: script, env: { ...process.env, HOME: there } }).toString();
const sync = () => syncDotfiles({ gitDir: `${here}/.dotfiles`, home: here }, machine);

{
  const result = await sync();
  check(
    "a first connect clones the repo there, keeps the machine's own files, and shows its edits as uncommitted",
    read(`${there}/.zshrc`) === 'zshrc there\n' &&
      read(`${there}/.claude/skills/a/SKILL.md`) === 'a, edited there\n' &&
      read(`${there}/.claude/skills/b/SKILL.md`) === 'b, first\n' &&
      read(`${there}/.claude/agents/helper.md`) === 'helper\n' &&
      show(result.there.dirty) === show(['.claude/skills/a/SKILL.md']) &&
      show(result.cloned) === show(['.claude/agents/helper.md', '.claude/skills/a', '.claude/skills/b']),
    show({ result, zshrc: read(`${there}/.zshrc`) }),
  );
}

{
  write(`${here}/.claude/skills/b/SKILL.md`, 'b, second\n');
  write(`${here}/.zshrc`, 'zshrc here, second\n');
  write(`${here}/.gitconfig`, '[user]\n');
  commit(here, 'two', '.claude/skills/b/SKILL.md', '.zshrc', '.gitconfig');
  const result = await sync();
  check(
    'a later connect fast-forwards the clone there, writing nothing outside the Claude paths',
    read(`${there}/.claude/skills/b/SKILL.md`) === 'b, second\n' &&
      read(`${there}/.zshrc`) === 'zshrc there\n' &&
      !fs.existsSync(`${there}/.gitconfig`) &&
      result.there.behind === 0 &&
      show(result.there.dirty) === show(['.claude/skills/a/SKILL.md']),
    show(result),
  );
}

{
  dot(there, 'commit', '-q', '-a', '-m', 'edited there');
  write(`${here}/.claude/skills/a/SKILL.md`, 'a, second\n');
  commit(here, 'three', '.claude/skills/a/SKILL.md');
  const result = await sync();
  check(
    'a clone there that cannot fast-forward is left as it is, and says how far behind and ahead it is',
    read(`${there}/.claude/skills/a/SKILL.md`) === 'a, edited there\n' &&
      result.there.behind === 1 &&
      result.there.ahead === 1,
    show(result),
  );
}

{
  execFileSync('git', ['clone', '-q', '--bare', origin, `${other}/.dotfiles`]);
  dot(other, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  dot(other, 'fetch', '-q', 'origin');
  dot(other, 'reset', '-q', 'origin/main');
  write(`${other}/.claude/skills/b/SKILL.md`, 'b, third\n');
  commit(other, 'four', '.claude/skills/b/SKILL.md');
  const forwarded = await sync();
  const skill = read(`${here}/.claude/skills/b/SKILL.md`);

  write(`${here}/.zshrc`, 'zshrc here, not committed\n');
  write(`${other}/.zshrc`, 'zshrc from elsewhere\n');
  commit(other, 'five', '.zshrc');
  const refused = await sync();
  check(
    'the repo here fast-forwards, unless an incoming commit touches a file changed here',
    skill === 'b, third\n' &&
      forwarded.here === null &&
      read(`${here}/.zshrc`) === 'zshrc here, not committed\n' &&
      typeof refused.here === 'string',
    show({ skill, forwarded: forwarded.here, refused: refused.here }),
  );
}

fs.rmSync(root, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
