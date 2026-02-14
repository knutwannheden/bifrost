# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Bifrost

Bifrost is a keyboard-centric Electron app for orchestrating parallel Claude Code agent sessions. Each task gets its own git worktree and PTY terminal running Claude Code, with live streaming via xterm.js.

## Commands

- `npm start` — run in development mode (Electron Forge + Vite HMR)
- `npm run lint` — ESLint check
- `npm run package` — build packaged app
- `npm run make` — build distributable installers

No test framework is configured.

## Architecture

### Process Model

Standard Electron three-process split, all TypeScript:

- **Main** (`src/main/`): Node.js process — PTY management, git operations, file watching, IPC handlers, HTTP API, MCP server
- **Preload** (`src/preload/preload.ts`): Bridges main↔renderer via `contextBridge`, exposing `window.bifrost` typed API
- **Renderer** (`src/renderer/`): React 19 UI with Tailwind CSS

Three separate Vite build targets configured in `forge.config.ts`.

### IPC Pattern

All IPC is defined in `src/shared/ipc-channels.ts`:

- `IPC` object: request-response channels (`ipcMain.handle` / `ipcRenderer.invoke`)
- `IPC_STREAM` object: event channels (`webContents.send` / `ipcRenderer.on`)
- `BifrostAPI` interface: fully typed API that the preload script implements and exposes as `window.bifrost`

To add a new IPC channel: add the channel string to `IPC` or `IPC_STREAM`, add the method signature to `BifrostAPI`, implement in `src/preload/preload.ts`, and register the handler in `src/main/ipc-handlers.ts`.

### Renderer State

`src/renderer/context/AppContext.tsx` uses React Context + `useReducer`. All UI state flows through `AppState` / `AppAction` types. Components dispatch actions; the reducer handles overlay mutual exclusion (only one overlay open at a time).

### Key Services (Main Process)

| Module | Purpose |
|--------|---------|
| `session-manager.ts` | Spawns/kills PTY sessions via node-pty |
| `ipc-handlers.ts` | Registers all IPC handlers, manages in-memory task list |
| `activity-watcher.ts` | Watches worktrees for file changes, commits, Claude JSONL events |
| `context-store.ts` | Structured context capture with JSONL persistence |
| `worktree-manager.ts` | Creates/removes git worktrees for tasks |
| `bifrost-api.ts` | HTTP API for MCP server integration |
| `claude-session-scanner.ts` | Discovers external Claude Code sessions for resumption |

### Key Renderer Modules

| Module | Purpose |
|--------|---------|
| `hooks/useTerminal.ts` | xterm.js lifecycle, Dracula theme, custom key handler |
| `hooks/useKeyboard.ts` | Global Cmd+key shortcuts, context capture flow |
| `components/DiffOverlay.tsx` | Git diff + activity log viewer with syntax highlighting (Shiki) |
| `components/TaskHistoryPanel.tsx` | Task management + external session resumption |
| `components/TerminalPane.tsx` | Terminal container with split pane support |

### Shared Types

`src/shared/types.ts` contains all types shared between processes: `Task`, `Repo`, `ActivityEntry`, `ContextEntry` variants, `BifrostConfig`, etc.

## Native Module Note

`node-pty` is a native module. The `forge.config.ts` has a `packageAfterCopy` hook to copy it into builds and asar unpack config. Don't import `node:os` in preload — Vite doesn't externalize it; use `process.env` instead.
