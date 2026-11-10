# Choosing the agent Bifrost runs

## Why

The user switches between two Claude subscriptions when one runs out of tokens. Codex and Copilot are two more things to switch to, not agents to run beside Claude on the same task. Everyday work has to keep going on the other agent: tasks, turn state, the bell, prompts, the console, `create_task` from inside a session, Restart sessions, machines. One machine may run Claude while another runs Codex.

The user's guidance: whatever does not carry over easily stays Claude-only for now.

## What is built

- **The setting:** `BifrostConfig.agent` here, and `Machine.agent` for a machine, which falls back to the agent here. The IDE sends each instance its machine's agent with the other preferences, on connect and on every settings save while linked. Session files are written from the settings each time a session starts, so no restart of Bifrost is needed. Restart sessions moves running sessions over.
- **The record:** `Task.agent` names the agent the conversation belongs to. Absent means Claude. `Task.sessionId` stays "the id that resumes it" in that agent's terms.
- **Starting and resuming** (`agents.ts`, run.sh):
  - Claude is unchanged.
  - Copilot starts and resumes with `--session-id`, which Bifrost chooses. It gets `--plugin-dir` with Bifrost's plugin, and `COPILOT_SKILLS_DIRS` pointing at the user's skills. Under skip-permissions it also gets `--allow-all` and `COPILOT_ALLOW_ALL`, which trusts the folder.
  - Codex picks its own id, which its first SessionStart hook reports. It resumes with `codex resume <id>` once a rollout exists. It gets Bifrost's hooks and MCP server as `-c` overrides, `--dangerously-bypass-hook-trust`, `--no-alt-screen`, `CLAUDE.md` as its project-doc fallback, and trust for the main checkout, which run.sh works out from git.
- **Hooks:** Bifrost's existing scripts serve both agents, since both use Claude's event names and payloads. Codex's PermissionRequest stands in for Notification. The plugin needed three changes to load in them:
  - no empty Notification matcher
  - quoted `argument-hint`s
  - the prompt-submit hook printing only real hook output
- **Handover** (`conversation-handover.ts`): when a session starts under an agent other than the task's, the old id moves to `sessionHistory`. The prompts and replies, without tool traffic, go to `~/.bifrost/sessions/<id>/conversation.md`, keeping the most recent 60k characters. The new session's first prompt points at that file. A task on a machine without its own instance is pointed at the old transcript there instead.
- **The console** starts with the agent set here. A console restarted under a different agent starts a new conversation. Each session directory records its agent in a file named `agent`.
- **Draft warning:** the screen reader also finds Codex's `›` prompt. Copilot draws Claude's `❯` between rules.
- **Messaging:** the MCP server tells Copilot and Codex sessions, which have no SendMessage, to use `send_prompt` and to say who they are.

## Verified

Both agents were run live, the way Bifrost starts them, against a fake API: Copilot 1.0.103 and Codex 0.167.0.
- SessionStart, UserPromptSubmit, PostToolUse and Stop arrive with the task's id.
- Bifrost's MCP tool answers through the API.
- Codex's id comes back, and `codex resume` picks the conversation up.

## Claude-only for now

- The token chart, the transcript half of the change feed, session metrics, and "Move to" carrying the conversation.
- Managed permissions, Remote Control, and Bifrost's own `claude -p` calls (titles, summaries, walkthroughs).
- The user's global `CLAUDE.md`, which neither agent reads. Codex also does not get the user's skills or Bifrost's.
- A Codex console's conversation: Restart sessions starts it over, since the console's id is never recorded.

## Open

- Whether to give Copilot and Codex the user's global rules by linking `~/.copilot/copilot-instructions.md` and `~/.codex/AGENTS.md` to Claude's `CLAUDE.md`. That would write into their homes, so it is the user's call.
