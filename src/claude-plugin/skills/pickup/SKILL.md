---
name: bifrost:pickup
description: Use when asked to "pick up", "continue from", "read handoff", or "receive handoff" from another Bifrost task. Reads and continues work from a structured handoff document.
argument-hint: [source-task-name]
---

Read a handoff document from another Bifrost task and continue the work described in it.

## 🚨 GATE FUNCTION

**READ ENTIRE HANDOFF BEFORE PROCEEDING**

Do not skip to "what remains". Read all sections:
1. Goal
2. Completed
3. Current State (builds? tests pass? blockers?)
4. Key Files
5. Remaining
6. Instructions

If you haven't read all sections, you're about to inherit hidden problems. Stop and read them.

## Workflow

1. Use `list_tasks` to get the list of tasks. Match `$1` (user argument) against task names — fuzzy/substring matching.
2. If no match or ambiguous, show full task list and ask user to pick one.
3. Read `~/.bifrost/tasks/{task-id}/handoff.md`.
4. If no handoff exists, tell the user and stop.
5. **Read and display the ENTIRE handoff** (all sections above).
6. Ask user to confirm before starting work.
7. Begin working on remaining items, following all instructions.

## Red Flags - Don't Start Work Yet

- [ ] You skipped reading "Current State" (could inherit broken build)
- [ ] You don't know what files to read first (Key Files missing)
- [ ] You're unsure what "completed" means (description too vague)
- [ ] You haven't read the special Instructions section

**Any flag above = ask user to clarify with previous session before proceeding.**

## Common Rationalizations - READ THE FULL HANDOFF

| Excuse | Reality |
|--------|---------|
| "I can infer the rest from the summary" | You can't. You'll inherit hidden problems. |
| "Current State is probably fine" | It's not fine if tests are failing. You need to know. |
| "I can figure out key files by exploring" | Next session depends on you telling them which files matter. |
| "Instructions are probably just 'continue'" | Not always. Could be "don't merge to main yet" or other critical details. |
| "The handoff summary tells me enough" | Summary is not enough. Read every section. |

**All of these mean: Read all sections before starting work.**
