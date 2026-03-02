---
name: bifrost:handoff
description: Use when the user explicitly asks to "hand off", "write a handoff", or "/handoff". Writes a structured handoff document summarizing this session's work. Do NOT use when creating new tasks.
argument-hint: [instructions]
---

Write a handoff document summarizing the current session's work so another Bifrost task can pick it up.

## 🚨 IRON LAW

**EVERY SECTION MUST CONTAIN CONCRETE DETAILS**

"Something" is not concrete. "Updated files" is not concrete. "Fixed bugs" is not concrete.

Concrete = file paths, function names, commit SHAs, line numbers, error messages, before/after code snippets.

The receiving session has ZERO context. Everything they need must be in this document. If you skip details, they're stuck.

## Workflow

1. Get task ID from `$BIFROST_TASK_ID`. If not set, tell user this must run inside Bifrost and stop.
2. Use `list_tasks` to find current task name (match by task ID).
3. Write `~/.bifrost/tasks/{task-id}/handoff.md` with this structure:

```markdown
# Handoff: {task-name}

## Goal
What this task set out to accomplish.

## Completed
List concrete changes: file paths modified, functions added, bugs fixed with details.

## Remaining
What still needs to be done. Be specific: exact next steps, file names, expected outcomes.

## Key Files
Files central to this work — the ones the next session should read FIRST. Include paths.

## Current State
- Builds? (yes/no + any errors)
- Tests pass? (yes/no + which ones failing if applicable)
- Known blockers or issues? (be specific)

## Instructions
{user's instructions from $1, or "Continue with the remaining items above." if none provided}
```

Fill based on actual conversation. Be concrete everywhere.

## Common Rationalizations - STOP

| Excuse | Reality |
|--------|---------|
| "I'll write vague summaries; they'll figure it out" | They can't. They have no context. Vague = stalled task. |
| "Updated files" without paths | Next session wastes 30 min searching for which files. |
| "Fixed the bug" without error message | Next session doesn't know what bug or if it's actually fixed. |
| "Tests failing" without listing which ones | Next session debugs wrong test suite. |
| "Key files are obvious" | They're not. List them explicitly. |

**All of these mean: Write concrete details in every section.**

## After Writing

Confirm to the user: "Handoff written to `~/.bifrost/tasks/{task-id}/handoff.md`"
