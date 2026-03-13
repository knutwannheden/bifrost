---
name: bifrost:merge-and-close
description: Use when the user asks to "merge and close", "merge the PR", "land and archive", "finish this task", or invokes /bifrost:merge-and-close. Checks CI, merges the PR, and archives the Bifrost task.
argument-hint: [task-id or PR number]
---

## 🚨 IRON LAW

**CI MUST BE GREEN BEFORE MERGE. NO EXCEPTIONS.**

Do not merge with pending checks. Do not merge with failed checks. Do not skip checks because "it's just a small change." Wait, poll, confirm — then merge.

Skipping this = broken main branch, reverted merges, wasted time for the whole team.

## Workflow

### 1. Identify the PR

- If a PR number or URL was provided as argument, use that.
- If a task ID was provided, call `list_tasks` to find the task, then derive the branch name and look up the PR:
  ```
  gh pr list --head <branch-name> --json number,title,url,state --jq '.[0]'
  ```
- If no argument was provided and `$BIFROST_TASK_ID` is set, use that task ID.
- If no PR is found for the branch, tell the user and **stop**.

### 2. Check CI status

Run:
```
gh pr checks <pr-number> --json name,state --jq '.[] | [.name, .state] | @tsv'
```

Evaluate the result:

| State | Action |
|-------|--------|
| All checks `SUCCESS` | Proceed to merge |
| Any check `PENDING` | Poll (see step 3) |
| Any check `FAILURE` | Report which checks failed and **stop** |
| No checks configured | Proceed to merge with a note to the user |

### 3. Poll for pending checks

If checks are still running, poll every 30 seconds up to 20 minutes:

```
gh pr checks <pr-number> --watch --fail-fast
```

The `--watch` flag blocks until all checks complete or one fails. If it exits with failure, report which checks failed and **stop**.

### 4. Merge the PR

Attempt merge:
```
gh pr merge <pr-number> --squash --delete-branch
```

Use `--squash` by default. If merge fails:

| Error | Action |
|-------|--------|
| Review required | Tell user a review approval is needed. Offer to request one: `gh pr edit <pr-number> --add-reviewer <user>`. Then **stop** — do not bypass review requirements. |
| Merge conflicts | Tell user there are merge conflicts that need manual resolution and **stop**. |
| Branch protection | Report the specific protection rule blocking merge and **stop**. |
| Other error | Report the error message verbatim and **stop**. |

### 5. Archive the Bifrost task

After successful merge, call the `close_or_archive_task` MCP tool with the task ID and `archive: true`.

### 6. Report

Confirm to the user:
- PR was merged (include PR URL)
- Branch was deleted
- Bifrost task was archived

## Common Rationalizations - STOP

| Excuse | Reality |
|--------|---------|
| "CI is probably fine, it was green last time" | Check. Every. Time. CI state changes between pushes. |
| "I'll merge now and fix CI later" | Broken main = everyone's problem. Wait for green. |
| "Review isn't really needed for this" | Branch protection exists for a reason. Request a review. |
| "I can force-merge past the protection" | Never. Report the blocker and let the user decide. |
| "Checks are taking too long, just merge" | 20 minutes is the limit. If exceeded, tell user — don't skip. |

**All of these mean: Follow the process. No shortcuts.**
