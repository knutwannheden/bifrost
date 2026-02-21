---
name: review-fix
description: This skill should be used when the user asks to "fix review items", "address review feedback", "resolve review comments", or invokes /bifrost:review-fix. Reads a Bifrost code review checklist and addresses all checked items.
argument-hint: [task-id]
---

Determine the task ID: use `$1` if provided, otherwise fall back to the `$BIFROST_TASK_ID` environment variable.

Find the review file to work on:

1. Read `~/.bifrost/tasks/{task-id}/reviews/index.json` — this is a JSON array of review entries, each with an `id` field
2. Pick the last entry in the array (the most recent review)
3. Read `~/.bifrost/tasks/{task-id}/reviews/{id}.md` where `{id}` is the review entry's id

If the `reviews/` directory doesn't exist, fall back to reading `~/.bifrost/tasks/{task-id}/review.md`.

Address all items marked with [x] (checked checkboxes). For each checked item, critically evaluate whether the finding is actually valid before acting on it — review findings can be wrong, overly cautious, or based on misunderstanding the code's intent.

For each checked item, edit the review file directly:
- If the finding is valid and you fix it: change `- [x] item` to `- [x] ✅ item`
- If the finding is incorrect or not worth addressing: change `- [x] item` to `- [x] ❌ item` and add an indented bullet with the rejection reason, e.g.:
  ```
  - [x] ❌ Potential null pointer on line 42
    - The value is guaranteed non-null by the guard clause on line 38
  ```
- Leave unchecked items (`- [ ]`) as-is

Focus only on the checked items. Work through them one at a time.
