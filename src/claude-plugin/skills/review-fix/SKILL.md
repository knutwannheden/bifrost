---
name: bifrost:review-fix
description: Use when the user asks to "fix review items", "address review feedback", "resolve review comments", or invokes /bifrost:review-fix. Addresses all checked items in a code review checklist.
argument-hint: <task-id> [review-id]
---

## 🚨 IRON LAW

**FIX FINDINGS FIRST, EVALUATE SECOND**

Do not rationalize away findings before looking at code. Read the code, understand why the reviewer flagged it, fix or reject with evidence — in that order.

Skipping this step = silently ignoring real issues because you're confident you know better.

## Workflow

1. **Resolve IDs:**
   - Let `TASK_ID` = first argument (`$1`). If not provided, fall back to `$BIFROST_TASK_ID`. If neither is available, tell user and **stop**.
   - Let `REVIEW_ID` = second argument (`$2`), if provided.
   - Verify `~/.bifrost/tasks/{TASK_ID}/` exists. If not, tell user and **stop — do NOT search for files.**

2. **Read review file:**
   - Read `~/.bifrost/tasks/{TASK_ID}/reviews/index.json` (array of review entries with `id` field)
   - If `REVIEW_ID` was set in step 1, find that entry; otherwise use the last entry (most recent) and set `REVIEW_ID` from its `id` field
   - Read `~/.bifrost/tasks/{TASK_ID}/reviews/{REVIEW_ID}.md`
   - If `reviews/` directory doesn't exist, fall back to `~/.bifrost/tasks/{TASK_ID}/review.md`
   - **If neither file exists, tell user and stop. Do NOT search for files.**

3. **Fix each item** marked `[x]`:
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
