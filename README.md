<p align="center">
  <img src="assets/icon-128.png" alt="Bifrost icon">
</p>

<h1 align="center">Bifrost</h1>

<p align="center">
  A keyboard-centric Electron app for orchestrating parallel Claude Code agent sessions.
</p>

## Overview

Bifrost lets you run multiple Claude Code sessions side-by-side, each in its own git worktree with a dedicated PTY terminal. It tracks file changes, commits, and Claude interactions in real time, and provides diff visualization with syntax highlighting.

## Features

- **Multi-task orchestration** — each task gets its own git worktree and Claude Code session
- **Live terminal streaming** — xterm.js terminals with Dracula theme
- **Split panes** — Claude + dev terminal side by side per task
- **Review sessions** — Cmd+J spawns a second Claude session to review the primary session's work, with visual purple tint and tab indicator
- **Git diff viewer** — syntax-highlighted diffs with per-file stat badges via Shiki
- **Git log viewer** — commit history filtered per worktree
- **Activity log** — file changes, commits, and Claude events tracked in real time
- **Task auto-summarization** — completed tasks are summarized via Claude CLI
- **Context capture** — Cmd+Shift+C captures terminal content or transcript references for cross-session sharing
- **Session resumption** — discover and resume external Claude Code sessions
- **IDE integration** — open files in VS Code or JetBrains IDEs
- **Settings** — IDE selection, font size, sandbox mode
- **MCP server** — exposes captured context to Claude via Model Context Protocol

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | New task |
| Cmd+W | Close pane / stop task |
| Cmd+/ | Toggle dev terminal |
| Cmd+J | Review session (create / cycle) |
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
