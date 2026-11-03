import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cloneLines, shQuote, type WorktreeSpec } from './remote-host.ts';

export interface PackSpec {
  worktreePath: string;
  /** A ref the other machine fetches fresh, so the commits on it travel without the bundle. */
  baseRef: string;
  transcript: string | null;
  /** Literal replacements in the transcript, made in order, so the longer path goes first. */
  rewrites: Array<[string, string]>;
}

/**
 * Writes what moving a task carries into a directory. That is HEAD's commit, a
 * bundle of the commits beyond baseRef, the staged and the unstaged changes as
 * binary patches, and the transcript with its paths rewritten. Untracked files
 * stay behind.
 */
export function packTask(spec: PackSpec, dir: string): void {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: spec.worktreePath, maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  fs.writeFileSync(path.join(dir, 'head'), git('rev-parse', 'HEAD'));
  // git refuses to write a bundle with nothing in it.
  if (Number(git('rev-list', '--count', `${spec.baseRef}..HEAD`).toString().trim()) > 0) {
    git('bundle', 'create', path.join(dir, 'bundle'), 'HEAD', `^${spec.baseRef}`);
  }
  fs.writeFileSync(path.join(dir, 'staged.patch'), git('diff', '--cached', '--binary'));
  fs.writeFileSync(path.join(dir, 'unstaged.patch'), git('diff', '--binary'));
  if (spec.transcript) {
    let text = fs.readFileSync(spec.transcript, 'utf-8');
    for (const [from, to] of spec.rewrites) text = text.split(from).join(to);
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), text);
  }
}

export interface UnpackSpec extends WorktreeSpec {
  /** Where packTask's directory was uploaded, relative to the home directory. */
  dropDir: string;
  sessionId: string;
}

/**
 * Rebuilds a packed task: a worktree on a branch at the same commit, the staged
 * and unstaged changes applied as they were, and the transcript filed where
 * Claude looks for it under the new path. Prints BRANCH, WORKTREE and BASE.
 */
export function unpackScript(spec: UnpackSpec): string {
  const base = shQuote(`origin/${spec.baseBranch}`);
  return [
    ...cloneLines(spec),
    `d="$HOME"/${shQuote(spec.dropDir)}`,
    'head=$(cat "$d/head")',
    'if [ -f "$d/bundle" ]; then git -C "$clone" fetch --quiet "$d/bundle" </dev/null; fi',
    'git -C "$clone" worktree add --quiet -b "$branch" "$wt" "$head"',
    `git -C "$wt" branch --quiet --set-upstream-to ${base} "$branch" || true`,
    'if [ -s "$d/staged.patch" ]; then git -C "$wt" apply --index "$d/staged.patch"; fi',
    'if [ -s "$d/unstaged.patch" ]; then git -C "$wt" apply "$d/unstaged.patch"; fi',
    'if [ -f "$d/transcript.jsonl" ]; then',
    `  projects="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf '%s' "$wt" | sed 's/[^A-Za-z0-9]/-/g')"`,
    '  mkdir -p "$projects"',
    `  mv "$d/transcript.jsonl" "$projects"/${shQuote(`${spec.sessionId}.jsonl`)}`,
    'fi',
    'rm -rf "$d"',
    `printf 'BRANCH=%s\\nWORKTREE=%s\\nBASE=%s\\n' "$branch" "$wt" ${base}`,
  ].join('\n');
}
