# Separating a task's branch from the branch it forked off

## Problem

`Task.branch` holds the ref a worktree was created *from* — `origin/main`, or `repo.defaultBranch` when no ref was chosen. `createWorktree` generates the worktree's actual branch through `resolveAvailableBranchName` and discards it, so a task's own branch is stored nowhere.

Consumers are split on which of the two they believe the field holds, and five of the eight are wrong:

| Site | Assumes | Today |
|---|---|---|
| Diff base (`ipc-handlers.ts:809`) | fork point | correct |
| `createWorktree(repo, name, branch, …)` | fork point | correct |
| `isWorktreeDisposable(path, baseRef)` | fork point | correct |
| `curator: gh pr view <branch>` | task's branch | queries the base branch's PR |
| `curator: git branch --merged … --list <branch>` | task's branch | matches on the base branch |
| `restoreWorktree(repo, task.name)` | task's branch | guesses via `slugify(name)` |
| `TaskHistoryPanel.tsx:460` comparison | task's branch | compares against a fork point |
| Tab tooltip, History search text | task's branch | shows `origin/main` for every task in a repo |

The merge check is the most visible casualty. Of 127 tasks classified `merged`, **108 have `branch = "main"`**, so the check runs `git branch --merged main --list main`, matches, and concludes the task was merged — it is asserting that main is merged into main. Only 19 `merged` verdicts rest on a real task branch.

## Approach

Give `branch` the meaning most call sites already assume, and move the fork point to a name that says what it is. The four broken consumers then become correct without being touched; the three correct ones are repointed explicitly.

`baseBranch` rather than `defaultBranch`: `Repo.defaultBranch` already exists and means the repository's main branch, which is a different thing — a task can fork from any ref.

## Schema

```ts
interface Task {
  /** The ref this worktree was created from. */
  baseBranch: string;
  /** The worktree's own branch; undefined when it could not be recovered. */
  branch?: string;
}
```

`branch` is optional because it is unrecoverable for most existing tasks. Of 1046 tasks, 141 have a worktree on disk and 905 do not — so `undefined` is the common case for archived tasks, and every consumer needs a defined answer for it rather than treating it as an edge case.

## Migration (schema version 3)

```sql
ALTER TABLE tasks RENAME COLUMN branch TO base_branch;
ALTER TABLE tasks ADD COLUMN branch TEXT;
```

Backfill `branch` from `git symbolic-ref --short HEAD` for each task whose worktree directory exists — 141 git calls, roughly two seconds, once. `symbolic-ref` fails on a detached HEAD, which correctly leaves those `NULL`. The remaining 905 stay `NULL`.

## Preventing recurrence

`createWorktree` returns the branch it created rather than discarding it:

```ts
createWorktree(...): Promise<{ worktreePath: string; branch: string }>
```

`createWorktreeFromPr` returns the PR head branch the same way, and `createTaskCore` stores both fields on the new task.

## The undefined contract

- **Curator classification** skips a task with no known branch. Producing nothing beats today's wrong answer.
- **Tooltip and History search** fall back to `baseBranch`, labelled as the fork point so the two are not confused.
- **`restoreWorktree`** keeps `slugify(name)` as its fallback but reports a clear failure when that ref does not exist, instead of silently restoring the wrong branch or none.

## Testing

No test framework is configured, so verification is by inspection against real data:

- Migration runs once against a copy of `~/.bifrost/bifrost.db`; assert 141 rows gain a `branch` and `base_branch` retains every previous value.
- A new task records both fields, and its `branch` matches `git symbolic-ref --short HEAD` in the created worktree.
- Curator classification is skipped for a task with `branch IS NULL`, and the `main`-merged-into-`main` verdict no longer appears.
- Reopening an archived task whose branch is unknown reports a legible failure rather than restoring the wrong worktree.

## Out of scope

- Shrinking worktrees with `git clean`. Measured separately: 20.2 GB across 66 worktrees, the largest 2.6 GB of Gradle output. Worth doing, but as an explicit action with a dry-run preview, never as a side effect of archiving, because `-fdX` also removes ignored-but-unrecoverable files such as `.env` and local credentials.
- Deleting the curator's outcome classification. If that happens first it removes two of the consumers this migration otherwise repairs.
- `renameWorktreeBranch`, which reads `HEAD` directly and stays authoritative regardless of what the field holds.
