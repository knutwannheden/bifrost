---
name: review-fix
description: This skill should be used when the user asks to "fix review items", "address review feedback", "resolve review comments", or invokes /bifrost:review-fix. Reads a Bifrost code review checklist and addresses all checked items.
---

Find the review file to work on:

1. Read `~/.bifrost/tasks/$BIFROST_TASK_ID/reviews/index.json` — this is a JSON array of review entries, each with an `id` field
2. Pick the last entry in the array (the most recent review)
3. Read `~/.bifrost/tasks/$BIFROST_TASK_ID/reviews/{id}.md` where `{id}` is the review entry's id

If the `reviews/` directory doesn't exist, fall back to reading `~/.bifrost/tasks/$BIFROST_TASK_ID/review.md`.

Address all items marked with [x] (checked checkboxes). As each item is resolved, edit the review file directly:
- Change `- [x] item` to `- [x] DONE: item` or add a brief note about the resolution
- Leave unchecked items (`- [ ]`) as-is

Focus only on the checked items. Work through them one at a time.
