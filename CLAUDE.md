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

## Renderer UI Conventions

### Fonts

Variable-width system font (`-apple-system, …`) for all UI. Monospace (`font-mono`) only for terminal content, code diffs, file paths, SHAs, and session IDs.

### Color Tokens

All colors use semantic CSS custom properties from `index.css`, referenced via Tailwind (`text-primary`, `bg-surface`, etc.). Never use raw hex/slate colors in components.

- `text-primary` — main text; `text-secondary` — labels, form labels, section headers; `text-muted` — timestamps, metadata, empty states; `text-faint` — keyboard hint text in footer bars
- `bg-surface` — panels/overlays; `bg-surface-alt` — inputs, secondary surfaces; `bg-surface-hover` — hovered rows
- `text-accent-hover` for primary action text (Open, Task); `text-danger` for destructive action text (Delete, Remove)

### Overlay Structure

All overlays follow this pattern:
- Backdrop: `absolute inset-0 z-20 bg-overlay focus:outline-none` with `tabIndex={-1}`, `onClick={close}`
- Inner panel: `bg-surface rounded-lg border border-border-input shadow-xl` with `onClick={(e) => e.stopPropagation()}`
- Header: `text-sm font-semibold text-primary` title + close button (`text-secondary hover:text-primary text-lg leading-none transition-colors`)
- Footer hint bar: `px-4 pb-3 pt-2 border-t border-border-default` with `text-xs text-faint` for keyboard hints
- Auto-focus container or first input on mount via `useEffect`

### Interactive Elements

- All hover-state buttons/links must include `transition-colors`
- Primary action buttons: `bg-accent hover:bg-accent-hover text-white rounded`
- Standard form input: `bg-surface-alt border border-border-input rounded text-sm text-primary placeholder-muted focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent`
- Section group headers: `text-xs font-semibold text-secondary uppercase tracking-wider`

### Reusable Components

Use existing components instead of reimplementing patterns:
- `ActionLabel` — underlined mnemonic hints (Alt+letter)
- `Kbd` — keyboard shortcut badges with platform-aware symbols
- `PillToggle` — segmented toggle buttons (filter tabs, scope selectors)
- `RepoDropdown` — searchable repo selector with arrow key navigation
- `SearchIndicator` — inline search bar shown during type-to-filter
- `Highlight` — multi-term search match highlighting
- `DiffStatsBadge` — +N/-N additions/deletions pill
- `Spinner` — loading indicator (sm/md sizes)
- `FlaskIcon` — experimental feature indicator
- `useInstantSearch` hook — type-to-filter with Backspace/Esc handling
