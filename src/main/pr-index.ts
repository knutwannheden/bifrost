import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Repo, Task, TaskPr } from '../shared/types';

const execFile = promisify(execFileCb);

const REFRESH_MS = 3 * 60 * 1000;
const GH_CHECK_MS = 5 * 60 * 1000;
/** A repo with more open branches than this has older PRs that no live task is on. */
const PR_LIMIT = 100;

interface RepoIndex {
  /** PR keyed by the branch it is opened from. */
  byBranch: Map<string, TaskPr>;
  fetchedAt: number;
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
  const index = { byBranch, fetchedAt: Date.now() };
  indexes.set(repo.id, index);
  return index;
}

/** Drop a repo's cache so the next lookup asks GitHub again. */
export function invalidatePrIndex(repoId: string): void {
  indexes.delete(repoId);
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
        return !index || now - index.fetchedAt > REFRESH_MS;
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
