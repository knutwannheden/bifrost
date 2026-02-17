# PR-Aware Task Creation

## Problem

When reviewing or working on a GitHub PR, users must manually find the branch, fetch it, and set up a task. Bifrost should detect PR links on the clipboard and streamline task creation.

## Design

### Clipboard Detection

When `TaskCreateDialog` mounts, read the clipboard via a new IPC call. If the text matches `https://github.com/<owner>/<repo>/pull/<number>`, parse out owner, repo, and PR number.

### Repo Matching

Compare `<owner>/<repo>` against `githubPath` on managed repos:

- **Match** → fetch PR metadata, auto-fill dialog
- **No match** → show dismissible message: "PR detected but repo is not managed in Bifrost"
- **Not a PR URL** → normal dialog behavior

### PR Metadata Fetch

New IPC channel `IPC.FETCH_PR_INFO` taking `{ repoPath, prNumber }`:

**Primary (`gh` CLI):**
```bash
gh pr view <number> --json headRefName,headRepositoryOwner,headRepository,title,number
```

**Fallback (no `gh`):**
```bash
git ls-remote origin refs/pull/<number>/head
```
Returns commit SHA. Branch name resolved by matching SHA against `git ls-remote origin` output. No PR title available.

Returns: `{ headBranch, headRepoOwner, headRepoName, isFork, title, number }`

### Branch Fetching

Handled during task creation (worktree setup):

- **Same-repo PR**: `git fetch origin <headBranch>`, create worktree from `origin/<headBranch>`, set upstream to `origin/<headBranch>`
- **Fork PR**: `git remote add <owner> <url>` (if not exists), `git fetch <owner> <headBranch>`, create worktree from `<owner>/<headBranch>`, set upstream

In both cases the worktree gets a new branch named after the task (auto-generated), based on the PR head. The upstream is set for pulling future updates.

### Dialog UI Changes

When PR info returns successfully:

- Auto-select matched repo
- Pre-select PR's head branch (added to branch list if not visible locally)
- Toast-style banner at top of dialog: **"PR #123: Fix auth bug"** with **Ignore** button that clears auto-fill
- Task name auto-generated as usual

### Welcome Screen `gh` Detection

On startup, check `gh` availability. If missing, show a recommendation pill on the welcome screen suggesting installation.

## Out of Scope

- Task creation for repos not yet managed in Bifrost
- General upstream tracking for non-PR tasks (e.g., pulling `origin/main` into task branches)
- `gh` installation automation
