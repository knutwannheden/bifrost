---
name: bifrost:review-fix
description: Use when the user asks to "fix review items", "address review feedback", "resolve review comments", or invokes /bifrost:review-fix. Addresses all checked items in a code review checklist.
argument-hint: [review-file-path]
---

## 🚨 IRON LAW

**FIX FINDINGS FIRST, EVALUATE SECOND**

Do not rationalize away findings before looking at code. Read the code, understand why the reviewer flagged it, fix or reject with evidence — in that order.

Skipping this step = silently ignoring real issues because you're confident you know better.

## Workflow

1. **Find review file:**
   - If a file path argument was provided, use it directly.
   - Otherwise, derive it from `$BIFROST_TASK_ID`:
     - Read `~/.bifrost/tasks/{BIFROST_TASK_ID}/reviews/index.json` (array of review entries with `id` field)
     - Use the last entry (most recent) and read `~/.bifrost/tasks/{BIFROST_TASK_ID}/reviews/{id}.md`
     - If `reviews/` directory doesn't exist, fall back to `~/.bifrost/tasks/{BIFROST_TASK_ID}/review.md`
   - If no argument and `$BIFROST_TASK_ID` is not set, tell user and **stop**.
   - **If the file doesn't exist, tell user and stop. Do NOT search for files.**

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
