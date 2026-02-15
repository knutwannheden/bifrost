---
name: review-fix
description: This skill should be used when the user asks to "fix review items", "address review feedback", "resolve review comments", or invokes /bifrost:review-fix. Reads a Bifrost code review checklist and addresses all checked items.
---

Read the BIFROST_TASK_ID environment variable to determine the task ID. Then read the review file at ~/.bifrost/tasks/<task-id>/review.md.

Address all items marked with [x] (checked checkboxes). As each item is resolved, edit the review file directly:
- Change `- [x] item` to `- [x] DONE: item` or add a brief note about the resolution
- Leave unchecked items (`- [ ]`) as-is

Focus only on the checked items. Work through them one at a time.
