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
- **Git diff viewer** — syntax-highlighted diffs via Shiki
- **Activity log** — file changes, commits, and Claude events tracked in real time
- **Context capture** — Cmd+Shift+C captures terminal content or transcript references for cross-session sharing
- **Session resumption** — discover and resume external Claude Code sessions
- **IDE integration** — open files in VS Code or JetBrains IDEs
- **MCP server** — exposes captured context to Claude via Model Context Protocol

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+T | New task |
| Cmd+W | Close pane / stop task |
| Cmd+/ | Toggle dev terminal |
| Cmd+D | Git diff |
| Cmd+A | Activity log |
| Cmd+R | Repositories |
| Cmd+H | Task history |
| Cmd+O | Open in IDE |
| Cmd+K | Keyboard shortcuts |
| Cmd+Shift+C | Capture context |
| Cmd+Shift+[ / ] | Previous / next tab |
| Cmd+1-9 | Switch to tab N |

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
