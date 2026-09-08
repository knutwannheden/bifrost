/** Days a worktree has to sit unused before its disk is worth reclaiming. */
export const KEEP_DAYS = 7;

/** The same, once the branch's PR has merged and the work has landed. */
export const MERGED_KEEP_DAYS = 2;

export interface WorktreeFacts {
  /** A repo's own checkout, as opposed to one added with `git worktree add`. */
  isMain: boolean;
  locked: boolean;
  /** A PTY Bifrost is running for the task that owns this worktree. */
  hasLiveSession: boolean;
  /** Any staged, unstaged or untracked change. */
  dirty: boolean;
  /** HEAD is merged into the origin default branch or on some remote ref. */
  reachable: boolean;
  /** Days since the worktree was last used. */
  idleDays: number;
  prMerged: boolean;
}

/**
 * Whether removing this worktree loses nothing: `git worktree add` rebuilds it,
 * and every gate below guards state that exists nowhere else.
 */
export function isReclaimable(f: WorktreeFacts): boolean {
  if (f.isMain || f.locked || f.hasLiveSession) return false;
  // A merged PR says the branch landed, not that the worktree stayed untouched.
  if (f.dirty || !f.reachable) return false;
  return f.idleDays >= (f.prMerged ? MERGED_KEEP_DAYS : KEEP_DAYS);
}

export interface WorktreeEntry {
  path: string;
  head?: string;
  branch?: string;
  locked: boolean;
  isMain: boolean;
}

/**
 * git lists the main worktree first and reports resolved paths, so position is
 * what identifies it — the path a caller holds may be a symlink to it.
 */
export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      const path = line.slice('worktree '.length);
      current = { path, locked: false, isMain: entries.length === 0 };
      entries.push(current);
    } else if (!current) {
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line.startsWith('locked')) {
      current.locked = true;
    }
  }
  return entries;
}
