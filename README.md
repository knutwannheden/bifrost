<p align="center">
  <img src="assets/icon-128.png" alt="Bifrost icon">
</p>

<h1 align="center">Bifrost</h1>

<p align="center">
  A keyboard-centric Electron app for orchestrating parallel Claude Code agent sessions.
</p>

## Overview

Work-in-progress Electron app. Built for myself because I couldn't find existing tools that fit how I wanted to work. I like GUIs that are fully keyboard-operable — think JetBrains IDEs. Rough around the edges, but genuinely useful as-is.

Bifrost is a keyboard-centric Electron app that works like a multi-tab terminal. You run multiple Claude Code sessions in parallel, each in its own git worktree with a dedicated terminal. You interact with Claude Code directly—Bifrost just manages the tabs, context isolation, and switching. Each task's context stays clean, and you jump between them without losing focus.

## Key Features

**Task Creation Skill**

You're deep in a task in Claude Code. An idea pops up—something related but separate. You invoke the task creation skill and describe the idea. The skill automatically crafts a prompt with the relevant context, creates a new task in Bifrost, and launches a Claude Code session that immediately starts working on it. You stay in your current Claude Code session the whole time.

Why does this matter? Your main session's context stays clean. You can parallelize work with minimal context pollution and without leaving your Claude Code session. The skill handles turning your idea into a properly-scoped task. I use this 5-10 times a day.

**Code Review (In Isolation)**

Run Claude-powered code reviews in a completely separate session. Your main context never gets polluted. Findings render as interactive Markdown with checkboxes—you pick which to address—and a generated prompt hands them off to your main session for fixes.

**Split Terminals: Claude Code + Dev Terminal**

Each task has both a Claude Code pane and a dev terminal pane, side by side. Toggle between them with Cmd+/ without leaving the app. Spawn a long-running command (tests, build, server), switch to Claude Code, work while it runs, then switch back when done. Everything stays in one window with full keyboard control.

## Core Features

- **Multi-session workflows** — Run multiple Claude Code sessions in parallel, each with its own git worktree and dedicated PTY terminal
- **Keyboard-centric navigation** — Switch between sessions, open diffs, manage tasks, and control the app entirely with keyboard shortcuts
- **Git diff viewer** — Syntax-highlighted diffs with per-file stats (via Shiki)
- **Activity log** — Real-time tracking of file changes, commits, and Claude events
- **Git log viewer** — Commit history filtered per worktree
- **MCP server** — Let Claude Code sessions access captured context, task diffs, and activity logs via Model Context Protocol

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | New task |
| Cmd+W | Close pane / stop task |
| Cmd+/ | Toggle dev terminal |
| Cmd+D | Git diff |
| Cmd+A | Activity log |
| Cmd+L | Git log |
| Cmd+R | Repositories |
| Cmd+H | Task history |
| Cmd+O | Open in IDE |
| Cmd+G | Open PR in GitHub |
| Cmd+K | Command palette |
| Cmd+, | Settings |
| Cmd+Shift+C | Capture context |
| Cmd+Shift+[ / ] | Previous / next tab |
| Cmd+1-9 | Switch to tab N |

## MCP Server

Bifrost includes an MCP server that lets Claude Code sessions access captured context, task diffs, and activity logs. On startup, Bifrost automatically installs the server to `~/.bifrost/mcp/`.

To enable it, add the following to your Claude Code MCP config (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "bifrost": {
      "command": "node",
      "args": ["~/.bifrost/mcp/server.mjs"]
    }
  }
}
```

The MCP server provides these tools:

| Tool | Description |
|------|-------------|
| `resolve_context` | Resolve a `[Bifrost #N]` context reference to its content |
| `list_tasks` | List all Bifrost tasks with status and branch info |
| `get_task_diff` | Get the git diff for a task |
| `get_activity_log` | Get recent file changes, commits, and Claude events |

The server communicates with Bifrost's HTTP API (port 7623-7632) via `~/.bifrost/api-port`. Sessions launched from Bifrost automatically receive `BIFROST_TASK_ID` and `BIFROST_API_PORT` environment variables.

## Development

```bash
npm install
npm start
```

## Packaging

```bash
npm run make
```

## Tech Stack

Electron 40, React 19, TypeScript, Vite, Tailwind CSS, xterm.js, node-pty, Shiki
