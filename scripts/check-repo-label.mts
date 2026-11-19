/**
 * The sidebar names a task's repo from its worktree when no repo here matches,
 * as for a task on another instance in a repo only that instance has.
 * Run with `npm run check:repo-label`.
 */
import { repoNameFromWorktree } from '../src/renderer/utils/paths.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const inWorktrees = repoNameFromWorktree('/home/coder/git/org/some-repo/.worktrees/add-a-thing');
check("a worktree in a repo's .worktrees is named after that repo", inWorktrees === 'some-repo', inWorktrees);

const elsewhere = repoNameFromWorktree('/home/coder/git/org/some-repo');
check('any other worktree is named by its path', elsewhere === '~/git/org/some-repo', elsewhere);

process.exit(failed === 0 ? 0 : 1);
