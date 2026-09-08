/**
 * The reclaim policy decides what a one-click button deletes, so every gate it
 * applies is pinned here. Run with `npm run check:reclaim`.
 */
import { isReclaimable, parseWorktrees, type WorktreeFacts } from '../src/main/disk-reclaim-policy.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

/** A worktree that clears every gate; each case below spoils exactly one. */
const reclaimable: WorktreeFacts = {
  isMain: false,
  locked: false,
  hasLiveSession: false,
  dirty: false,
  reachable: true,
  idleDays: 30,
  prMerged: false,
};

const spoil = (f: Partial<WorktreeFacts>) => isReclaimable({ ...reclaimable, ...f });

check('a clean, pushed, idle worktree is reclaimable', isReclaimable(reclaimable));

check("a repo's main worktree is never touched", !spoil({ isMain: true }));
check('a locked worktree is left alone', !spoil({ locked: true }));
check('a worktree whose session is running is left alone', !spoil({ hasLiveSession: true }));
check('uncommitted work is never deleted', !spoil({ dirty: true }));
check('commits that exist on no remote are never deleted', !spoil({ reachable: false }));
check('a worktree used within the idle window is kept', !spoil({ idleDays: 3 }));

check('a merged PR reclaims its worktree sooner', spoil({ prMerged: true, idleDays: 3 }));
check('a merged PR still leaves an idle floor', !spoil({ prMerged: true, idleDays: 1 }));

check(
  'a merged PR shortens the idle window and nothing else',
  !spoil({ prMerged: true, idleDays: 30, dirty: true }) && !spoil({ prMerged: true, idleDays: 30, reachable: false }),
);

{
  const porcelain = [
    'worktree /Users/me/git/real-name',
    'HEAD abc',
    'branch refs/heads/main',
    '',
    'worktree /Users/me/git/real-name/.worktrees/feature',
    'HEAD def',
    'branch refs/heads/feature',
    '',
  ].join('\n');
  const [checkout, linked] = parseWorktrees(porcelain);

  check("a repo's own checkout is never a candidate, whatever path it was reached by", checkout.isMain);
  check('the entries after it are linked worktrees', !linked.isMain && linked.branch === 'feature');
}

process.exit(failed === 0 ? 0 : 1);
