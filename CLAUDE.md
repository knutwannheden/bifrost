# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Bifrost

Bifrost is a keyboard-centric Electron app for orchestrating parallel coding agent sessions. Each task gets its own git worktree and a session of Claude Code, Copilot CLI or Codex in tmux, streamed live to xterm.js.

## Commands

- `npm start` — run in development mode (Electron Forge + Vite HMR)
- `npm run lint` — Biome check (linting + formatting)
- `npm run build:headless` — build a Bifrost instance with no window, run with `node .vite/headless/headless.js`
- `npm run check:mirror` — verify a joining terminal replays a session's screen exactly once
- `npm test` — vitest suite for `tools/postmortem`
- `npm run package` — build packaged app
- `npm run make` — build distributable installers

`tools/postmortem` has a vitest suite (`npm test`). The Electron app itself has no test framework;
`scripts/` holds standalone checks for invariants worth pinning, and `restart-bifrost.sh`.

## Architecture

### Process Model

Standard Electron three-process split, all TypeScript:

- **Main** (`src/main/`): Node.js process — sessions in tmux and dev-terminal PTYs, git operations, file watching, IPC handlers, HTTP API, MCP server
- **Preload** (`src/preload/preload.ts`): Bridges main↔renderer via `contextBridge`, exposing `window.bifrost` typed API
- **Renderer** (`src/renderer/`): React 19 UI with Tailwind CSS

Three separate Vite build targets configured in `forge.config.ts`. A fourth, `vite.headless.config.mts`, builds `headless.ts` for plain Node. It runs an instance with no window, which `instance.ts` starts as it does for the IDE.

Only `main.ts`, `ipc-handlers.ts`, `notification-service.ts` and `slack-service.ts` import Electron, and only they import each other. `biome.json` enforces this. Every other main-process module reaches the window through `event-sink.ts`. It raises an event there, and `main.ts` forwards each event to the window. The bell for a task that wants attention is an event too, which `notification-service.ts` plays.

### IPC Pattern

All IPC is defined in `src/shared/ipc-channels.ts`:

- `IPC` object: request-response channels (`ipcMain.handle` / `ipcRenderer.invoke`)
- `IPC_STREAM` object: event channels (`emit` from `event-sink.ts` / `ipcRenderer.on`)
- `BifrostAPI` interface: fully typed API that the preload script implements and exposes as `window.bifrost`

To add a new IPC channel: add the channel string to `IPC` or `IPC_STREAM`, add the method signature to `BifrostAPI`, implement in `src/preload/preload.ts`, and add the handler to `calls` in `src/main/ipc-calls.ts`. A handler that needs the window or Electron goes in `src/main/ipc-handlers.ts` instead.

### Renderer State

`src/renderer/context/AppContext.tsx` uses React Context + `useReducer`. All UI state flows through `AppState` / `AppAction` types. Components dispatch actions; the reducer handles overlay mutual exclusion (only one overlay open at a time).

### Key Services (Main Process)

| Module | Purpose |
|--------|---------|
| `session-manager.ts` | Keeps one stream per session: a tmux control client for Claude, node-pty for a dev shell |
| `tmux-control.ts` | A tmux control-mode client for one session: the pane's own bytes out, keys in, and a replay on joining |
| `tmux-session.ts` | The files and tmux command line a session runs from, the same on every machine |
| `session-mirror.ts` | Headless xterm per session; shapes the replay for the terminal that attaches |
| `instance.ts` | Starts and stops the services a Bifrost instance runs, with or without a window |
| `event-sink.ts` | Hands each event a service raises to everyone listening, such as the window |
| `ipc-calls.ts` | The IPC calls that need no window, by channel, which another instance can run too |
| `ipc-handlers.ts` | Registers the IPC calls, and the handlers that need the window |
| `task-service.ts` | The task list and the operations on tasks that the IPC handlers, the HTTP API and the background services share |
| `activity-watcher.ts` | Watches worktrees for commits and Claude JSONL events |
| `claude-watcher.ts` | Parses Claude JSONL session files for token usage, turn boundaries, and tool attribution |
| `context-store.ts` | Structured context capture with JSONL persistence |
| `worktree-manager.ts` | Creates/removes git worktrees for tasks |
| `bifrost-api.ts` | HTTP API for MCP server integration |
| `claude-session-scanner.ts` | Discovers external Claude Code sessions for resumption |
| `curator-service.ts` | Background task outcome tracking and auto-archiving |
| `supervisor-service.ts` | Batch processing of notes across repos |
| `triage-service.ts` | AI-powered prompt triage into tasks |
| `prompt-sender.ts` | Programmatic prompt injection into running sessions |
| `permission-manager.ts` | Approval flow for tool use in managed-permissions mode |
| `session-metrics.ts` | Postmortem session analysis (token waste, backtracking) |
| `walkthrough-service.ts` | Generates a guided walkthrough of a branch's committed change, and stores it per task |
| `walkthrough-anchor.ts` | Checks a walkthrough's anchors against the commits, and follows them onto a later head |
| `remote-host.ts` | Runs task sessions and commands on a configured machine over a shared SSH connection |
| `peers.ts` | Links this instance to the instances on other machines, whose tasks it lists and whose calls it forwards |

### Sessions in tmux

Every agent session, the console included, runs in a tmux session named after it on Bifrost's own tmux server (`tmux -L bifrost`). It starts from `~/.bifrost/sessions/<id>/run.sh`, which resumes the transcript under the task's session id when there is one. Bifrost reads each session as a tmux control-mode client, so a tab gets the program's own bytes, links and colours included.

Quitting Bifrost only detaches, so its sessions run on, and opening a tab or waking a task joins them again. A client that joins replays the pane's scrollback, its screen and the terminal modes tmux reports. Dev terminals are plain PTYs and end with Bifrost.

"Restart sessions" in the command palette restarts the session of each running task that has one, here and on other machines, one after another. Then it restarts each console the console overlay has a tab for, which carries its conversation on. It leaves a session that is mid-turn alone. It first warns about text typed at a prompt, which a restart loses, and reads that from the pane, where Claude and Codex draw a suggestion or placeholder faint.

### Agents

Sessions run Claude Code unless Settings → Agent picks Copilot or Codex. A machine under Machines can run its own agent, which the IDE sends to that machine's instance with the other preferences. A session starts with its machine's agent, so a running one moves to a new choice on Restart sessions. `agents.ts` holds each agent's command line. Each machine needs the agent installed and logged in there.

Copilot and Codex get Bifrost's hooks and MCP server on their command line, so Bifrost writes nothing into `~/.copilot` or `~/.codex`. Copilot loads the plugin with `--plugin-dir`, and its skills include the user's. Codex takes the hooks and server as `-c` overrides and skips hook trust, which also makes it run as its own process, so hooks see the session's environment. Neither reads the user's global `CLAUDE.md`. Codex reads a repo's `CLAUDE.md` in place of an `AGENTS.md`. Bifrost chooses the session id up front for Claude and Copilot. Codex picks its own, and its first SessionStart hook reports it.

A task records the agent its conversation belongs to. When its session starts under another agent, `conversation-handover.ts` writes the prompts and replies to `~/.bifrost/sessions/<id>/conversation.md`, and the new session's first prompt points at that file. A task on a machine without its own instance is pointed at the old transcript there instead.

Some things stay Claude-only:
- the features that read Claude's transcripts: the token chart, the transcript half of the change feed, session metrics, and "Move to" carrying the conversation
- managed permissions
- Remote Control
- Bifrost's own `claude -p` calls

Copilot and Codex have no SendMessage, so the MCP server tells their sessions to use `send_prompt`.

### Tasks on other machines

A task with `machine` set runs on a host from `BifrostConfig.machines`, reached with plain `ssh` and whatever `~/.ssh/config` says about it. Its `worktreePath` is a path on that machine, so the services that read worktrees or transcripts from local disk skip it. Cmd+O or a file link opens one of its files in Zed with an `ssh://` URL to that machine's host. Other editors refuse it. An image pasted into one of its sessions, with Cmd+V or Ctrl+V, is copied to `~/.bifrost/paste` on that machine, and its path is pasted at the prompt. Its dev terminal is a login shell in that worktree over `ssh`, and ends with Bifrost like any dev terminal. SendMessage does not cross machines.

Bifrost keeps one OpenSSH master connection per machine, under `~/.bifrost/ssh/`. Tabs and commands share it, and it forwards the API to the machine for the copy of the plugin there. At start, Bifrost connects to each machine a task was open on when it last quit.

On the machine, a repo is cloned once, at the path it has here relative to home, so `~/git/org/repo` there too. A task's worktree sits in the clone's `.worktrees/`. Claude runs in tmux there as it does here, and the tab's control client reaches it over `ssh`, so Claude outlives the connection and Bifrost. A connection that drops is retried, and the tab is redrawn from the new client's replay.

Nobody may be there to answer Claude's first-run screens, so Bifrost answers them up front. Connecting marks onboarding done, setting up a session trusts its worktree, and the session's `--settings` settle the renderer and the warning about skipped permissions.

A task here moves to another machine with "Move to" in its context menu (`task-transfer.ts`). Its commits beyond its base travel as a git bundle, and its staged and unstaged changes as patches. Its transcript travels with the worktree and home paths rewritten, and is filed under the directory Claude names after the new path, so the session resumes there under the same id. Untracked files stay behind. The local worktree is removed unless it holds some.

A machine with "Sync setup" on gets this machine's Claude setup on every connect (`remote-sync.ts`). Each part travels to the same path relative to home, is replaced whole, and travels only when its hash changed:

- Each skill, agent and command under `~/.claude`, and the status line script.
- The `CLAUDE.md` files in the directories above the configured repos.
- `settings.json`, with home paths rewritten.
- The enabled plugins and their marketplaces. A directory marketplace sends only its manifest and the enabled plugins.
- Bifrost's `tools/headroom`, linked into `~/.local/bin`, and the extra paths from the settings.

On a machine with rsync, a sync that changes anything runs rsync once over the whole setup into `~/.bifrost/sync-copy` there, and the changed parts are copied into place from it. rsync then sends only the files that differ from what the last sync left in that copy. A machine without rsync gets the changed parts as a tarball. With `-R`, macOS's openrsync leaves files deleted here in place on a GNU rsync, so it is one directory, not one call naming several paths.

A dotfiles repo set in the settings, one whose work tree is home, gives each machine with Sync setup on a clone of its own at the same path (`dotfiles.ts`). The clone checks out only Claude's skills, agents, commands and status line, and the machine keeps its own shell and git setup. Its first checkout writes only missing files, so a file the machine already holds stays, and an edit there shows as a change. Every connect fast-forwards the repo here, then the clone there. Neither moves past a change in the way or a diverged history, and a toast says what is behind, unpushed or not committed. The sync leaves the entries the repo tracks to the clone, and neither sends nor removes them.

`~/.claude/CLAUDE.md` is the exception. The machine's own may be written by something else, such as a provisioning script that rewrites a block of it on every start, so the rules go to `~/.bifrost/claude/CLAUDE.md` and the machine's file only gains a line importing them. Bifrost's own plugin stays out, since remote sessions load it with `--plugin-dir`.

Sessions run with the Claude config dir Bifrost runs with, `CLAUDE_CONFIG_DIR`, at the same path relative to home on every machine. Each `run.sh` and each remote script sets it, or clears it when Bifrost runs without one. Settings → Agent → Claude Account picks it from `~/.claude` and each `~/.claude-*` dir that holds a login, and the palette has an entry for each other one. Bifrost takes the choice into its own environment at once, and a running session moves to it on Restart sessions. Without a choice, Bifrost keeps the dir it was launched with. A machine's instance keeps the IDE's from the preferences. When that dir is not `~/.claude`, sync recreates its top-level links into `~/.claude` there as relative links, and never writes its `.claude.json` or login. Each machine needs its own login in that dir, made once there. When it has none, connecting says so, and the notification's Log in runs Claude's login there in a terminal here.

An instance can also link to the Bifrost instance on another machine (`peers.ts`). It subscribes to that instance's events (`POST /events`, one JSON object per line), then lists its tasks. The stream carries an empty line every 15 seconds, so a quiet instance's link stays open. A link that ends without being closed here is opened again after 5 seconds, then at doubling intervals up to a minute. It keeps the last list in `~/.bifrost/peers/<name>.json`, which the window shows greyed while that instance is away. Each instance gives a repo its own id, so a peer's task is shown with the id of the repo here that has the same GitHub slug. That instance's repo list is kept beside its tasks for this, in `<name>.repos.json`, apart from the list here. A call about one of those tasks, or an answer to a request one of its sessions raised, goes to that instance's `POST /call`. That route runs the same table, `ipc-calls.ts`, as the IPC handlers here.

`RemoteHost.ensureInstance()` brings up Bifrost's own instance on a machine. When the machine's build differs from the one here, the build is unpacked into `~/.bifrost/instance.new` and `npm install` runs there for the native file watcher. Only then does it replace `~/.bifrost/instance`. The instance runs in a respawn loop in a tmux session named `instance` on Bifrost's tmux server, so it outlives the connection and comes back after a crash, and restarting it leaves the other sessions running. The IDE reaches its API through a loopback forward on the shared connection, which then stays open.

A machine with "Run Bifrost there" on runs that instance, and it owns the tasks there (`instance-link.ts`). The IDE registers it as a peer, whose connect brings it up and copies it the preferences here. A task created or moved there still goes through the scripts below, then its record is handed to the instance with `POST /import-tasks` and forgotten here once the instance confirms. The tasks the IDE held for the machine move the same way when the setting is turned on, or at the next start. The machine's `api-port` then names its instance, and the connection writes the IDE's forwarded port to `ide-port`. Sessions the instance starts get the plugin directory and first-run settings that remote sessions get, and a tab still reads its session over ssh.

Each time the IDE connects to such an instance, it posts `/link-back` with the port the IDE's API is forwarded to there. The instance then links to the IDE as its peer `ide`, and its tools list the IDE's tasks while that link is up. There `create_task` keeps a task for `"local"` or the machine's own name. It sends any other name to the IDE, `"ide"` included. The plugin describes these values where its API is the machine's own instance, which it tells by `api-port` matching `instance-port`.

Every remote step is a shell script built in `remote-host.ts`, `task-transfer.ts`, `remote-sync.ts` or `dotfiles.ts`. The checks `check:remote-scripts`, `check:task-transfer`, `check:remote-sync` and `check:dotfiles` run them against a local home directory.

### Restarting Bifrost from a task

Bifrost runs in development mode from a checkout, and a change to the main process takes effect only after a restart. A restart leaves the sessions in tmux running, the one asking for it included, and ends dev terminals. `scripts/restart-bifrost.sh` does it from inside a task, and "Restart Bifrost" in the command palette runs it from the window, after saying how many dev terminals it ends. It detaches and returns at once, and its log goes to `~/.bifrost/restart/`.

It waits for an exclusive headroom claim on the cpu, so no claimed run is cut off. It asks Bifrost to quit with SIGTERM, kills it only when it does not, and starts `npm start` again from the same checkout, detached from any terminal. Once Bifrost answers, it joins the sessions in use again, and prompts the task that ran it to carry on. A session counts as in use when it was mid-turn or changed turn state in the last hour. The others wait for their tabs to be opened, as after any restart.

- `--revert FROM..TO` names the commits just merged. A build that does not come up is reverted in the working tree, and the previous one started.
- When no build comes up, a headless `claude -p` gets the logs and the job of bringing Bifrost back.
- `--prompt TEXT` adds to the prompt the calling task gets.
- `--while-stopped COMMAND` runs between the quit and the start, when nothing holds Bifrost's database, such as for a repair to it.

### Key Renderer Modules

| Module | Purpose |
|--------|---------|
| `hooks/useTerminal.ts` | xterm.js lifecycle, configurable terminal themes, custom key handler |
| `hooks/useKeyboard.ts` | Global Cmd+key shortcuts, context capture flow |
| `components/DiffOverlay.tsx` | Git diff + activity log viewer with syntax highlighting (Shiki) |
| `components/TokenUsageChart.tsx` | Per-turn token usage bar/line chart with turn detail panel |
| `components/WalkthroughContent.tsx` | Walkthrough tab of the diff overlay: steps in narrated order over the pinned diff |
| `hooks/useTokenUsage.ts` | Fetches parsed token data from main process via IPC |
| `components/TaskHistoryPanel.tsx` | Task management + external session resumption |
| `components/TerminalPane.tsx` | Terminal container with split pane support |

### Theming

UI theme (`system`/`dark`/`light`) is controlled by `BifrostConfig.theme`. The `useTheme` hook in `hooks/useTheme.ts` applies a `light` class on `<html>`, which swaps CSS custom properties defined in `index.css`. Terminal themes are independent — `terminal-themes.ts` defines named xterm `ITheme` objects; `'Auto'` selects based on UI dark/light mode. Shiki syntax highlighting in `utils/syntax-highlight.ts` accepts a `dark` flag to switch between `github-dark` and `github-light` themes.

### Shared Types

`src/shared/types.ts` contains all types shared between processes: `Task`, `Repo`, `ActivityEntry`, `ContextEntry` variants, `BifrostConfig`, etc.

## Linting

Biome is used for linting and formatting (`biome.json`), covering `src/`, `tools/` and `scripts/`. A11y rules are disabled (Electron app, not web). Run `npm run lint` to check; `npx biome check --write src/ tools/ scripts/` to auto-fix. Invoke Biome with explicit paths — a bare `biome check` walks into `.worktrees/` and trips over the nested config there.

## Native Module Note

`node-pty` is a native module. The `forge.config.ts` has a `packageAfterCopy` hook to copy it into builds and asar unpack config. Don't import `node:os` in preload — Vite doesn't externalize it; use `process.env` instead.

## Vite HMR

HMR is disabled in `vite.renderer.config.mts` (`hmr: false`). Do not re-enable — it causes terminal components to remount after ~30s of inactivity, clearing the active terminal.

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
- Backdrop: `absolute inset-0 z-20 bg-overlay focus:outline-hidden` with `tabIndex={-1}`, `onClick={close}`
- Inner panel: `bg-surface rounded-lg border border-border-input shadow-xl` with `onClick={(e) => e.stopPropagation()}`
- Header: `text-sm font-semibold text-primary` title + close button (`text-secondary hover:text-primary text-lg leading-none transition-colors`)
- Footer hint bar: `px-4 pb-3 pt-2 border-t border-border-default` with `text-xs text-faint` for keyboard hints
- Auto-focus container or first input on mount via `useEffect`

### Interactive Elements

- All hover-state buttons/links must include `transition-colors`
- Primary action buttons: `bg-accent hover:bg-accent-hover text-white rounded-sm`
- Standard form input: `bg-surface-alt border border-border-input rounded-sm text-sm text-primary placeholder-muted focus:outline-hidden focus:border-accent focus:ring-1 focus:ring-accent`
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
- `OverlayHeader` — standard overlay header with title + close button
- `OverlayFooter` — standard overlay footer with border
- `CloseButton` — × close button with hover state
- `FormInput` — styled text input with focus ring
- `FormSelect` — styled select dropdown with focus ring
- `FormTextarea` — styled textarea with focus ring
- `PrimaryButton` — accent-colored action button (sm/md sizes)
- `SectionHeader` — uppercase tracking-wider section label
