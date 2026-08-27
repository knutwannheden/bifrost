import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Repo, Task, TaskPr } from '../shared/types';

const execFile = promisify(execFileCb);

/** How long an untouched index stands before it is asked again. */
const REFRESH_MS = 3 * 60 * 1000;
/** A floor under a marked index, so a run of finishing turns cannot spin gh. */
const MIN_REFRESH_MS = 20 * 1000;
const GH_CHECK_MS = 5 * 60 * 1000;
/** A repo with more open branches than this has older PRs that no live task is on. */
const PR_LIMIT = 100;

interface RepoIndex {
  /** PR keyed by the branch it is opened from. */
  byBranch: Map<string, TaskPr>;
  fetchedAt: number;
  /** Something happened that could have opened a PR. */
  stale: boolean;
}

const indexes = new Map<string, RepoIndex>();
let ghAvailable: boolean | null = null;
let ghCheckedAt = 0;

async function isGhAvailable(): Promise<boolean> {
  if (ghAvailable !== null && Date.now() - ghCheckedAt < GH_CHECK_MS) return ghAvailable;
  try {
    await execFile('gh', ['--version'], { timeout: 5000 });
    ghAvailable = true;
  } catch {
    ghAvailable = false;
  }
  ghCheckedAt = Date.now();
  return ghAvailable;
}

interface GhPr {
  number: number;
  state: string;
  isDraft: boolean;
  headRefName: string;
  url: string;
}

interface GhCheck {
  status?: string;
  conclusion?: string;
  state?: string;
  /** A GitHub Actions job carries detailsUrl; a third-party status carries targetUrl. */
  detailsUrl?: string;
  targetUrl?: string;
}

interface GhOpenPr {
  number: number;
  mergeStateStatus?: string;
  reviewDecision?: string;
  statusCheckRollup?: GhCheck[];
}

const RUNNING_STATES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING']);
const FAILED_STATES = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ERROR']);

/**
 * What an open PR is waiting on, most urgent first: a run in flight, then a
 * failure, then whether GitHub would merge it as it stands. The check that
 * decided it comes along, so the dot can lead to the run rather than the PR.
 */
function progressOf(pr: GhOpenPr): Pick<TaskPr, 'progress' | 'checkUrl'> {
  const checks = pr.statusCheckRollup ?? [];
  const running = checks.find((c) => RUNNING_STATES.has((c.status ?? c.state ?? '').toUpperCase()));
  if (running) return { progress: 'running', checkUrl: running.detailsUrl ?? running.targetUrl };
  const failed = checks.find((c) => FAILED_STATES.has((c.conclusion ?? c.state ?? '').toUpperCase()));
  if (failed) return { progress: 'failing', checkUrl: failed.detailsUrl ?? failed.targetUrl };
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return { progress: 'blocked' };
  return { progress: pr.mergeStateStatus === 'CLEAN' ? 'ready' : 'blocked' };
}

/**
 * One `gh pr list` covers a repo's whole task set, where `gh pr view` would
 * cost a subprocess and a round trip per task.
 */
async function refresh(repo: Repo): Promise<RepoIndex> {
  const byBranch = new Map<string, TaskPr>();
  try {
    const { stdout } = await execFile(
      'gh',
      // Scoped to the user's own PRs: on a busy repo the newest hundred overall
      // would not reach back to the branch a task is still on.
      // biome-ignore format: one flag per pair reads better than the wrapped form
      ['pr', 'list', '--author', '@me', '--state', 'all',
       '--limit', String(PR_LIMIT), '--json', 'number,state,isDraft,headRefName,url'],
      { cwd: repo.path, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    for (const pr of JSON.parse(stdout) as GhPr[]) {
      const state = pr.isDraft && pr.state.toUpperCase() === 'OPEN' ? 'draft' : pr.state.toLowerCase();
      // gh lists newest first, so an older PR never displaces the current one.
      if (!byBranch.has(pr.headRefName)) {
        byBranch.set(pr.headRefName, { number: pr.number, state: state as TaskPr['state'], url: pr.url });
      }
    }
  } catch {
    /* not a GitHub repo, unauthenticated, or offline — the repo simply has no PRs to show */
  }
  // Asked for separately: mergeStateStatus and the check rollup triple the time
  // of the listing above, and only an open PR has anything left to wait on.
  if ([...byBranch.values()].some((pr) => pr.state === 'open' || pr.state === 'draft')) {
    try {
      const { stdout } = await execFile(
        'gh',
        // biome-ignore format: one flag per pair reads better than the wrapped form
        ['pr', 'list', '--author', '@me', '--state', 'open',
         '--limit', String(PR_LIMIT), '--json', 'number,mergeStateStatus,reviewDecision,statusCheckRollup'],
        { cwd: repo.path, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const progress = new Map<number, ReturnType<typeof progressOf>>();
      for (const open of JSON.parse(stdout) as GhOpenPr[]) progress.set(open.number, progressOf(open));
      for (const pr of byBranch.values()) {
        const p = progress.get(pr.number);
        if (!p) continue;
        pr.progress = p.progress;
        if (p.checkUrl) pr.checkUrl = p.checkUrl;
      }
    } catch {
      /* the pill still carries the number; it just says nothing about progress */
    }
  }

  const index = { byBranch, fetchedAt: Date.now(), stale: false };
  indexes.set(repo.id, index);
  return index;
}

/**
 * Note that a repo may have gained a PR. The next lookup past the floor asks
 * GitHub again, rather than waiting out the full refresh window.
 */
export function markPrIndexStale(repoId: string): void {
  const index = indexes.get(repoId);
  if (index) index.stale = true;
}

/** The PR each task's branch has, for every task whose branch has one. */
export async function getTaskPrs(tasks: Task[], repos: Repo[]): Promise<Record<string, TaskPr>> {
  if (!(await isGhAvailable())) return {};

  const wanted = new Set(tasks.filter((t) => t.branch).map((t) => t.repoId));
  const now = Date.now();
  await Promise.all(
    repos
      .filter((r) => wanted.has(r.id))
      .filter((r) => {
        const index = indexes.get(r.id);
        if (!index) return true;
        const age = now - index.fetchedAt;
        return index.stale ? age > MIN_REFRESH_MS : age > REFRESH_MS;
      })
      .map((r) => refresh(r)),
  );

  const result: Record<string, TaskPr> = {};
  for (const task of tasks) {
    if (!task.branch) continue;
    const pr = indexes.get(task.repoId)?.byBranch.get(task.branch);
    if (pr) result[task.id] = pr;
  }
  return result;
}
