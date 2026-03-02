---
name: bifrost:review-fix
description: Use when the user asks to "fix review items", "address review feedback", "resolve review comments", or invokes /bifrost:review-fix. Addresses all checked items in a code review checklist.
argument-hint: [task-id] [review-id]
---

## 🚨 IRON LAW

**FIX FINDINGS FIRST, EVALUATE SECOND**

Do not rationalize away findings before looking at code. Read the code, understand why the reviewer flagged it, fix or reject with evidence — in that order.

Skipping this step = silently ignoring real issues because you're confident you know better.

## Workflow

1. Get task ID: first argument (`$1`), or fall back to `$BIFROST_TASK_ID`. Verify `~/.bifrost/tasks/{task-id}/` exists.

2. Find review file:
   - Read `~/.bifrost/tasks/{task-id}/reviews/index.json` (array of review entries with `id` field)
   - If second argument (`$2`) provided, find that `id`; otherwise use last entry (most recent)
   - Read `~/.bifrost/tasks/{task-id}/reviews/{id}.md`
   - If `reviews/` directory doesn't exist, fall back to `~/.bifrost/tasks/{task-id}/review.md`

3. For each item marked `[x]`:
   - Read the code at the flagged location
   - Understand WHY the reviewer flagged it
   - **Then** decide: fix or reject
   - Mark `- [x] ✅ item` (fixed) or `- [x] ❌ item` (rejected with reason)
   - If rejected, add indented reason:
     ```
     - [x] ❌ Potential null pointer on line 42
       - Value guaranteed non-null by guard clause on line 38
     ```

4. Leave unchecked items (`- [ ]`) as-is.

## Common Rationalizations - STOP

| Excuse | Reality |
|--------|---------|
| "I know this code works, skip this finding" | You haven't read the code yet. Look first. |
| "The reviewer was being overly cautious" | You find out by reading code, not by assumption. |
| "I'll fix it after testing" | Fix now, test after. Deferring hides real issues. |
| "This is too minor" | Minor = still a valid finding. Fix it. |
| "I can see why they flagged it, I'll skip it anyway" | Then document the rejection. Don't just ignore it. |

**All of these mean: Read the code, then decide. No shortcuts.**
