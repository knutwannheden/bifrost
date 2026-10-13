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

## 3. Draft task name and prompt

- **Name**: A short task title, max ~50 characters (e.g. "Add dark mode support"). Shown in tabs and history. The branch and worktree names are auto-generated — do NOT pass a branch name.
- **Prompt**: A concise, actionable prompt for the new task's Claude session, built from two halves:
  - **What only you know** — the core objective, design decisions and the reasoning behind them, what was ruled out, constraints the user stated, anything in this conversation the new task cannot look up.
  - **Pointers to the rest** — file paths, issue and PR numbers, branch names, failing run ids, with a line on what to look for in each. The new task has its own tools and a fresh context window; it reads a source faster than you can paraphrase one, and your paraphrase is the lossy copy.

Keep the prompt to a few paragraphs — actionable instructions, not a transcript dump.

**Write it from what you already have.** Making the task well-posed is the job; researching it is not. If answering something would mean opening a file, running `git log` or `gh`, or checking whether a failure still reproduces, that is a pointer: name the file, the command or the symptom and let the new task run it. Stop once the task is unambiguous rather than once it is settled, and mark what you did not check — "unverified: may already be fixed on main".

**Important**: The new task runs in a fresh git worktree branched from the main branch. If the prompt references files that haven't been merged yet (e.g. files created in your current worktree), provide the absolute path to the file or the repo path and branch name so the new task can locate them.

## 4. Confirm if needed

If the user's intent was fully and clearly specified in the arguments, proceed directly to creation. If you had to synthesize or infer anything significant, show the proposed name and prompt and ask for approval before creating.

## 5. Create

Call the `create_task` MCP tool with these parameters:
- `name`: the task title from step 3
- `prompt`: the drafted prompt from step 3
- `repo`: the resolved repo path from step 2 (omit if same repo as current task)

**IMPORTANT**: The parameter is called `prompt`, NOT `text`. Do NOT use `text` — that is a different tool's parameter.

## 6. Report

Tell the user the task was created and is running in a new Bifrost tab.

## Common Rationalizations - STOP

| Excuse | Reality |
|--------|---------|
| "I'll reference this uncommitted file" | New task won't see it. Reference fails silently. |
| "I can describe what I did instead" | Description without code = task has to reverse-engineer it. |
| "New task can check my branch" | True, but they still need the absolute path or branch name in the prompt. |
| "This is minor context they'll figure out" | "I'll figure it out later" = task grinds to halt. Spell it out now. |
| "I'll paste in the issue text or the file contents" | The new task can fetch those. Give the number or path, and say what matters in it. |
| "I'll summarize what the review said" | Keep your conclusion, drop the retelling. Point at the thread and let them read it. |
| "Let me check whether this is still broken first" | The new task checks, in a context window it has all of. Write "unverified" and hand it over. |
| "I'll find the exact line numbers for them" | The file and the symbol are enough. They have grep; you have a prompt to write. |
| "I should read the file before describing the change" | That spends your context to save theirs, which is backwards. |
| "A little more analysis makes the prompt better" | Past unambiguous it only makes it longer. Well-posed, not well-researched. |

**All of these mean: point precisely — absolute paths, branch names, committed work — and stop there.**
