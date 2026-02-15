---
name: review-fix
description: Address checked review items from a Bifrost code review. Use when the user invokes /bifrost:review-fix or asks to fix review items.
---

Read the BIFROST_TASK_ID environment variable to determine your task ID. Then read the review file at ~/.bifrost/tasks/<task-id>/review.md.

Address all items marked with [x] (checked checkboxes). As you resolve each item, edit the review file directly:
- Change `- [x] item` to `- [x] DONE: item` or add a brief note about the resolution
- Leave unchecked items (`- [ ]`) as-is

Focus only on the checked items. Work through them one at a time.
