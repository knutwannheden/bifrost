---
name: bifrost:epic
description: Propose or start a Bifrost epic for a goal that needs several independently addressable tasks.
argument-hint: "[goal and workflow preferences]"
---

An epic is a task you can talk to while it coordinates other task sessions. Use an ordinary task for work one session can handle.

Call `list_epic_templates` for starter prompts:

- **Plan the workflow first** when the user names no workflow. The epic explores the goal and writes its own.
- **Implement and review** for independent review and fixes.
- **Investigate in parallel** for independent evidence and a recommendation.
- **Implement, review, and measure** for a change with a measured acceptance target on a named machine.

Use the [workflow vocabulary](workflow.md) to adapt a starter or draft a prompt. A role can specify an agent, model, effort, machine, or hardware requirement. When the user asks to see a proposal, show the goal, workflow text, and any placement or decision they need to supply. When the user asks to start, call `create_epic` with a short name, the goal and either `template_id` for a starter or `template_text` for adapted prose. For **Plan the workflow first**, say in the goal whether the user wants to approve the plan or have the epic start at once. The epic's own session assigns and creates its workers. Return its name and task ID.
