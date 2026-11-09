import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseScriptOutput } from './remote-host.ts';
import { shQuote } from './tmux-session.ts';

const execFile = promisify(execFileCallback);

/** What a machine checks out of the dotfiles repo, relative to home. Its shell and git setup stay its own. */
const PATHS = ['.claude/skills/', '.claude/agents/', '.claude/commands/', '.claude/statusline.sh'];

export interface DotfilesHere {
  /** The repository, whose work tree is home. */
  gitDir: string;
  home: string;
}

export interface DotfilesThere {
  behind: number;
  ahead: number;
  /** Paths with changes not committed there. */
  dirty: string[];
  problem?: string;
}

export interface DotfilesResult {
  /** The entries the repo tracks, which the clone there keeps. */
  cloned: string[];
  /** Why the repo here did not fast-forward, or null. */
  here: string | null;
  there: DotfilesThere;
}

/** The repo here fast-forwards for one machine at a time, since several connect at once. */
let hereTurn: Promise<unknown> = Promise.resolve();

/**
 * Fast-forwards the repo here, then has the machine clone it or fast-forward its
 * clone. Neither side moves when it has diverged or a change in the way.
 */
export async function syncDotfiles(
  local: DotfilesHere,
  run: (script: string) => Promise<string>,
): Promise<DotfilesResult> {
  const git = async (...args: string[]) =>
    (
      await execFile('git', [`--git-dir=${local.gitDir}`, `--work-tree=${local.home}`, ...args], { cwd: local.home })
    ).stdout.trim();
  const turn = hereTurn.catch(() => {}).then(() => fastForward(git));
  hereTurn = turn;
  const here = await turn;
  const cloned = entries((await git('ls-files', '--', ...PATHS)).split('\n').filter(Boolean));
  const gitDir = homeRelative(local.home, local.gitDir);
  const excludes = await git('config', 'core.excludesfile').catch(() => '');
  const script = dotfilesScript(
    await git('remote', 'get-url', 'origin'),
    gitDir,
    excludes ? homeRelative(local.home, excludes.replace(/^~(?=\/)/, local.home)) : undefined,
  );
  let there: DotfilesThere;
  try {
    there = readThere(await run(script), gitDir);
  } catch (err) {
    there = { behind: 0, ahead: 0, dirty: [], problem: (err as Error).message };
  }
  return { cloned, here, there };
}

/** The result as sentences for the user, none when both sides are current and clean. */
export function dotfilesProblems({ here, there }: DotfilesResult): string[] {
  const problems: string[] = [];
  if (here) problems.push(`the dotfiles repo here did not fast-forward: ${here}`);
  if (there.problem) problems.push(there.problem);
  if (there.behind > 0)
    problems.push(`its dotfiles clone is ${there.behind} commit(s) behind and did not fast-forward`);
  if (there.ahead > 0) problems.push(`its dotfiles clone has ${there.ahead} commit(s) not pushed`);
  if (there.dirty.length > 0) problems.push(`its dotfiles clone has changes not committed: ${there.dirty.join(', ')}`);
  return problems;
}

async function fastForward(git: (...args: string[]) => Promise<string>): Promise<string | null> {
  try {
    await git('fetch', '-q', 'origin');
    if (Number(await git('rev-list', '--count', 'HEAD..@{u}')) === 0) return null;
    await git('merge', '--ff-only', '-q', '@{u}');
    return null;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    return stderr ? stderr.split('\n').slice(0, 3).join(' ') : (err as Error).message;
  }
}

/** Each tracked file's entry: the skill, agent or command it belongs to, or the file itself. */
function entries(files: string[]): string[] {
  const of = (file: string) => {
    const dir = PATHS.find((p) => p.endsWith('/') && file.startsWith(p));
    return dir ? dir + file.slice(dir.length).split('/')[0] : file;
  };
  return [...new Set(files.map(of))].sort();
}

function homeRelative(home: string, file: string): string {
  const relative = path.relative(home, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${file} is outside the home directory, so it has no place on a machine`);
  }
  return relative.split(path.sep).join('/');
}

/**
 * Clones the repo with home as its work tree and only PATHS checked out, or
 * fast-forwards that clone. The first checkout writes only missing files, so
 * an edit the machine already holds shows as a change. bifrost.setup marks a
 * clone this script made, and one without it is left alone.
 */
export function dotfilesScript(url: string, gitDir: string, excludes?: string): string {
  const dir = `"$HOME"/${shQuote(gitDir)}`;
  const repo = `git --git-dir=${dir}`;
  const g = `${repo} --work-tree="$HOME"`;
  const patterns = [...PATHS, ...(excludes ? [excludes] : [])];
  const checkedOut = `^(${patterns.map((p) => p.replace(/[.]/g, '\\.') + (p.endsWith('/') ? '' : '$')).join('|')})`;
  return [
    'set -e',
    'cd "$HOME"',
    `if [ ! -e ${dir} ]; then git clone -q --bare ${shQuote(url)} ${dir} && ${repo} config bifrost.setup started; fi`,
    `case "$(${repo} config bifrost.setup || true)" in`,
    `  done) ${g} fetch -q origin ;;`,
    '  started)',
    `    ${repo} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
    `    branch=$(${repo} symbolic-ref --short HEAD)`,
    `    ${repo} config branch."$branch".remote origin`,
    `    ${repo} config branch."$branch".merge refs/heads/"$branch"`,
    `    ${repo} config core.sparseCheckout true`,
    `    ${repo} config core.sparseCheckoutCone false`,
    // Home is full of files the patterns leave out, which would otherwise lose that mark.
    `    ${repo} config sparse.expectFilesOutsideOfPatterns true`,
    ...(excludes ? [`    ${repo} config core.excludesfile "$HOME"/${shQuote(excludes)}`] : []),
    `    printf '/%s\\n' ${patterns.map(shQuote).join(' ')} > ${dir}/info/sparse-checkout`,
    `    ${g} fetch -q origin`,
    `    ${g} read-tree HEAD`,
    `    ${g} ls-files | grep -v -E ${shQuote(checkedOut)} | ${g} update-index --skip-worktree --stdin`,
    `    ${g} ls-files --deleted | ${g} checkout-index --stdin`,
    `    ${repo} config bifrost.setup done ;;`,
    '  *) echo DOTFILES_FOREIGN=1; exit 0 ;;',
    'esac',
    `if [ "$(${g} rev-list --count HEAD..@{u})" -gt 0 ]; then ${g} merge --ff-only -q @{u} >/dev/null 2>&1 || true; fi`,
    `printf 'DOTFILES_BEHIND=%s\\n' "$(${g} rev-list --count HEAD..@{u})"`,
    `printf 'DOTFILES_AHEAD=%s\\n' "$(${g} rev-list --count @{u}..HEAD)"`,
    `printf 'DOTFILES_DIRTY=%s\\n' "$(${g} status --porcelain | cut -c4- | tr '\\n' ' ')"`,
  ].join('\n');
}

function readThere(output: string, gitDir: string): DotfilesThere {
  const out = parseScriptOutput(output);
  if (out.DOTFILES_FOREIGN) {
    return {
      behind: 0,
      ahead: 0,
      dirty: [],
      problem: `its ~/${gitDir} was not cloned by Bifrost, so it is left alone`,
    };
  }
  return {
    behind: Number(out.DOTFILES_BEHIND) || 0,
    ahead: Number(out.DOTFILES_AHEAD) || 0,
    dirty: (out.DOTFILES_DIRTY ?? '').split(' ').filter(Boolean),
  };
}
