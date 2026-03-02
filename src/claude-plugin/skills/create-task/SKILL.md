---
name: bifrost:create-task
description: Use when the user asks to "create a task", "spawn a task", "start a new task", or invokes /bifrost:create-task. Creates a new Bifrost task with a well-formed prompt.
argument-hint: [description of the work]
---

Create a new Bifrost task, synthesizing context from the current conversation into a well-formed prompt for the new task's Claude session.

## 🚨 IRON LAW

**NEW TASK = FRESH WORKTREE FROM MAIN BRANCH**

The new task gets a git worktree based on `main`, NOT your current branch. Uncommitted files and unmerged branches do not exist in the new task.

**If you reference uncommitted code:**
- Use absolute file paths with full context
- Or reference the current branch by name (new task can `git checkout <branch>`)
- Or commit your work first, then create the task

Not doing this = new task gets broken references and cannot proceed.

## 1. Parse intent

Extract what the user wants the new task to accomplish from `$1` (the skill argument) and the conversation history. If the user gave a clear description, use that as the basis. If vague or absent, summarize the relevant conversation context — brainstorming output, design decisions, discussed features, constraints.

## 2. Resolve repo

Pass the repo as a filesystem path (e.g. `~/git/org/repo`) or GitHub slug (e.g. `org/repo`) via the `repo` parameter. The tool resolves and auto-adds unknown repos. If the task targets the current repo, `repo` can be omitted. Only fall back to `list_repos` if no repo context is available from the conversation.

## 3. Draft task name, branch, and prompt

- **Name**: A short human-readable task name (e.g. "Add dark mode support").
- **Branch**: A kebab-case branch name derived from the task name (e.g. `add-dark-mode-support`). Keep it under 50 characters.
- **Prompt**: A concise, actionable prompt for the new task's Claude session. Include:
  - The core objective
  - Relevant context from the current conversation (design decisions, constraints, key details)
  - Any specific instructions the user mentioned

Keep the prompt to a few paragraphs — actionable instructions, not a transcript dump.

**Important**: The new task runs in a fresh git worktree branched from the main branch. If the prompt references files that haven't been merged yet (e.g. files created in your current worktree), provide the absolute path to the file or the repo path and branch name so the new task can locate them.

## 4. Confirm if needed

If the user's intent was fully and clearly specified in the arguments, proceed directly to creation. If you had to synthesize or infer anything significant, show the proposed name and prompt and ask for approval before creating.

## 5. Create

Call the `create_task` MCP tool with the resolved repo, name, branch, and prompt.

## 6. Report

Tell the user the task was created and is running in a new Bifrost tab.

## Common Rationalizations - STOP

| Excuse | Reality |
|--------|---------|
| "I'll reference this uncommitted file" | New task won't see it. Reference fails silently. |
| "I can describe what I did instead" | Description without code = task has to reverse-engineer it. |
| "New task can check my branch" | True, but they still need the absolute path or branch name in the prompt. |
| "This is minor context they'll figure out" | "I'll figure it out later" = task grinds to halt. Spell it out now. |

**All of these mean: Include absolute paths, branch names, or commit your work before creating the task.**
