# Multi-Repo Tasks

## Problem

Cross-repo work is common — a change in one repository often requires coordinated changes in others. Currently, users create a task for one repo and manually tell Claude Code where to find other repos on the filesystem. This is fragile: Claude has no structured awareness of the multi-repo context, and there's no worktree isolation for the secondary repos.

## Design

### Overview

A multi-repo task creates a lightweight Git repository that serves as a container, with worktrees from each selected repo checked out as subdirectories. Claude Code runs in the container directory and has structured access to all repos via a generated CLAUDE.md.

### Filesystem Layout

```
~/.bifrost/multi-tasks/<task-slug>/
├── .git/
├── .gitignore          ← lists repo subdirectory names
├── CLAUDE.md           ← documents the setup (tracked)
├── repo-a/             ← worktree from repo-a (gitignored)
└── repo-b/             ← worktree from repo-b (gitignored)
```

### Data Model Changes

**Repo** — one new optional field:

```typescript
interface Repo {
  // ...existing fields...
  multiTaskId?: string;  // set when this repo is a synthetic container for a multi-repo task
}
```

**Task** — no changes. A multi-repo task is a regular task whose `repoId` points to the container repo and `worktreePath` is the container directory. Note: `inPlace` is NOT set — multi-repo tasks use a distinct code path (see Cleanup).

**CreateTaskParams** — add a new optional field for the multi-repo flow:

```typescript
interface CreateTaskParams {
  // ...existing fields...
  multiRepoIds?: string[];  // repo IDs for multi-repo task creation
}
```

When `multiRepoIds` is present, `repoId`, `branch`, `inPlace`, and `prInfo` are ignored.

The relationship between a container repo and its constituent repos is implicit in the filesystem — subdirectories are worktrees from those repos.

### Creation Flow

When the user creates a multi-repo task with selected repos and a task name:

1. Generate the task ID upfront (needed for `multiTaskId` on the container repo)
2. Create directory `~/.bifrost/multi-tasks/<task-slug>/`
3. Run `git init` in the container directory
4. For each selected repo:
   a. Resolve an available branch name using `resolveAvailableBranchName` (handles the case where `<task-slug>` already exists as a branch)
   b. Run `git worktree add <container>/<dir-name> -b <branch-name> <defaultBranch>` from the repo's main checkout
   c. If two repos have the same `name`, disambiguate directory names (e.g., append a suffix)
5. Write `.gitignore` listing each repo subdirectory name
6. Write `CLAUDE.md` documenting the setup — which repos are present, their paths, what branch they're on
7. Commit the initial state (`.gitignore` + `CLAUDE.md`)
8. Register the container as a Repo in Bifrost config with `multiTaskId` set to the task ID
9. Create the Task with `repoId` pointing to the container repo, `worktreePath` = container path
10. Start PTY session with `cwd` = container path

Branch selection is not configurable per repo — each worktree branches off the repo's `defaultBranch`.

**Rollback on failure:** If any worktree creation fails mid-way, remove all already-created worktrees and delete the container directory. Report the error to the user.

### Archive / Cleanup

Multi-repo tasks are identified by checking whether the task's repo has `multiTaskId` set. Both `archiveTaskCore` and `destroyTask` need multi-repo-aware cleanup.

When a multi-repo task is archived or deleted:

1. For each subdirectory in the container that is a git worktree: read its `.git` file to find the parent repo's `.git` directory, then run `git worktree remove <path>` with `cwd` set to the parent repo
2. Delete the container directory (`rm -rf`)
3. Unregister the container Repo from Bifrost config

This differs from single-repo tasks where worktrees linger on disk. For multi-repo tasks, the container repo has no purpose outside its task, so both are cleaned up together.

**Reopening archived multi-repo tasks is not supported.** The container and worktrees are deleted on archive — there is nothing to restore. The UI should hide the reopen action for these tasks.

### Create Task Dialog Changes

The dialog gets a `PillToggle` at the top: **Single Repo** | **Multi Repo**.

**Single Repo mode** — exactly as today, no changes.

**Multi Repo mode** — simplified form:
- Multi-select list of known Bifrost repos (checkboxes)
- Task name (auto-generated or custom, same as today)
- Prompt textarea
- No branch picker, no in-place toggle, no PR detection

### Generated CLAUDE.md

The container's CLAUDE.md should document:

- That this is a multi-repo task managed by Bifrost
- Each constituent repo: name, original path, branch name, and a brief note about what it contains (if available from the repo's own CLAUDE.md)
- That changes should be made in the repo subdirectories, not the container root
- That each repo subdirectory is a git worktree with its own branch

Example:

```markdown
# Multi-Repo Task: migrate-auth-system

This is a multi-repo task managed by Bifrost. Each subdirectory is a git worktree
from a separate repository, all on the `migrate-auth-system` branch.

## Repos

| Directory | Repository | Branch |
|-----------|-----------|--------|
| `backend/` | /Users/knut/git/backend | `migrate-auth-system` (from `main`) |
| `frontend/` | /Users/knut/git/frontend | `migrate-auth-system` (from `main`) |

Make changes in the repo subdirectories, not in this root directory.
Each subdirectory has its own git history — commit changes within each repo directory separately.
Do not run git commands (commit, push, etc.) from this root directory.
```

### Degraded Features

Some Bifrost features operate on `task.worktreePath` and assume a single git repo. For multi-repo tasks, the container repo's git state is not meaningful (constituent repos are gitignored). The following features will not work correctly without adaptation:

- **Activity watcher / dirty indicator**: Monitors `worktreePath` for git changes — will show nothing since changes happen in subdirectories. For v1, accept this limitation.
- **Diff overlay / git log**: Runs `git diff` and `git log` on `worktreePath` — will show container commits only (initial `.gitignore` + `CLAUDE.md`). For v1, disable the diff overlay for multi-repo tasks.
- **Diff stats badges**: Will show 0 additions/deletions. For v1, hide the badge for multi-repo tasks.

These can be enhanced in future iterations to aggregate across constituent repos.

## Out of Scope

- Per-repo branch selection (always uses `defaultBranch`)
- PR detection for multi-repo tasks
- In-place mode (container is always a fresh repo)
- Adding/removing repos from an existing multi-repo task after creation
- Aggregated diff/activity views across multiple repos
- Reopening archived multi-repo tasks
