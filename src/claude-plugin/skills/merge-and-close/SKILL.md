---
name: bifrost:merge-and-close
description: Use when the user asks to "merge and close", "merge the PR", "land and archive", "finish this task", or invokes /bifrost:merge-and-close. Checks open review feedback and CI, merges the PR, and archives the Bifrost task.
argument-hint: [task-id or PR number]
---

## 🚨 IRON LAW

**CI MUST BE GREEN AND REVIEW FEEDBACK MUST BE SETTLED BEFORE MERGE. NO EXCEPTIONS.**

Do not merge with pending checks. Do not merge with failed checks. Do not skip checks because "it's just a small change." Wait, poll, confirm — then merge.

Do not merge with an unresolved review thread or a comment nobody answered. A merged PR is where feedback stops being actionable, and the person who left it has no way to tell whether it was read or missed.

Skipping this = broken main branch, reverted merges, feedback silently dropped, wasted time for the whole team.

## Workflow

### 1. Identify the PR

- If a PR number or URL was provided as argument, use that.
- If a task ID was provided, call `list_tasks` to find the task, then derive the branch name and look up the PR:
  ```
  gh pr list --head <branch-name> --json number,title,url,state --jq '.[0]'
  ```
- If no argument was provided and `$BIFROST_TASK_ID` is set, use that task ID.
- If no PR is found for the branch, tell the user and **stop**.

### 2. Check for unsettled feedback

This comes before CI because it is cheap and it is a stop condition: polling checks for twenty minutes is wasted on a PR a reviewer is still waiting on.

Resolution state is not in the REST fields, so the threads need GraphQL. Get `<owner>` and `<repo>` from `gh repo view --json owner,name --jq '.owner.login, .name'`:

```
gh api graphql -f query='
  query($owner:String!, $repo:String!, $pr:Int!) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$pr) {
        reviewDecision
        reviewThreads(first:100) {
          nodes { isResolved isOutdated path line comments(first:1) { nodes { author { login } body } } }
        }
      }
    }
  }' -F owner=<owner> -F repo=<repo> -F pr=<pr-number>
```

Then the PR conversation and whether it predates the last push:

```
gh pr view <pr-number> --json comments,commits --jq '{head: (.commits | last | .committedDate), comments: [.comments[] | {author: .author.login, at: .createdAt, body: (.body[0:120])}]}'
```

| Finding | Action |
|---------|--------|
| Any thread with `isResolved: false` | List each — file, line, author, first line of the comment — and **stop** |
| `reviewDecision: CHANGES_REQUESTED` | Name who requested changes and **stop** |
| A comment created after the head commit's date | Quote it, say it has had no push since, and ask the user before going on |
| Comments all predate the head commit, no open threads | Say what you found and proceed to CI |

Report what is open; never reply to a comment and never resolve a thread. Answering feedback changes the code, which is the task's work, and posting to GitHub is the user's call.

### 3. Check CI status

Run:
```
gh pr checks <pr-number> --json name,state --jq '.[] | [.name, .state] | @tsv'
```

Evaluate the result:

| State | Action |
|-------|--------|
| All checks `SUCCESS` | Proceed to merge |
| Any check `PENDING` | Poll (see step 4) |
| Any check `FAILURE` | Report which checks failed and **stop** |
| No checks configured | Proceed to merge with a note to the user |

### 4. Poll for pending checks

If checks are still running, poll every 30 seconds up to 20 minutes:

```
gh pr checks <pr-number> --watch --fail-fast
```

The `--watch` flag blocks until all checks complete or one fails. If it exits with failure, report which checks failed and **stop**.

### 5. Merge the PR

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

### 6. Archive the Bifrost task

After successful merge, call the `close_or_archive_task` MCP tool with `archive: true` and no `taskId` — it defaults to the task you are running in. Pass a `taskId` only when the user named a different task.

### 7. Report

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
| "That review comment was only a nit" | Whoever left it decides that, not you. Report it and stop. |
| "The thread is outdated, the code moved on" | Outdated means the line shifted, not that the point was answered. |
| "I'll address the comments in a follow-up" | Say that to the user before merging, not instead of telling them. |
| "I can resolve the thread myself, it's handled" | Resolving is posting to GitHub. Not yours to do. |

**All of these mean: Follow the process. No shortcuts.**
