# Event Sink and Task Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Main-process services reach the renderer only through an event sink, and the task logic lives apart from the IPC registration, so a headless instance can later run them without Electron. Nothing the user sees changes.

**Architecture:** `event-sink.ts` keeps a list of listeners. A service calls `emit(channel, ...args)` where it calls `win.webContents.send(channel, ...args)` today. `main.ts` subscribes one listener that forwards every event to the current window. The OS notification for a waiting task becomes a `BELL` event that `notification-service.ts` subscribes to. The task list and its operations move from `ipc-handlers.ts` into `task-service.ts`, and `ipc-handlers.ts` keeps only the IPC registration. A Biome rule keeps `electron` and the window-side modules out of every other main-process module.

Before and after, for one event:

```ts
// before: curator-service.ts holds the window
if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC_STREAM.CURATOR_UPDATE, taskId, curation);
// after
emit(IPC_STREAM.CURATOR_UPDATE, taskId, curation);
```

**Tech Stack:** TypeScript, Electron 43 main process, Biome 2.5 (`style/noRestrictedImports`), standalone check scripts run with `node scripts/check-*.mts`.

**Spec:** `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md`, step 2 of "Order of work", and "The headless instance" for what step 3 needs from it.

## Global Constraints

- "This changes no behaviour." (spec, Order of work, step 2). Every event keeps its channel name and its argument order.
- The window side is exactly `src/main/main.ts`, `src/main/ipc-handlers.ts`, `src/main/notification-service.ts` and `src/main/slack-service.ts`. Only these import `electron`, and only these import one another.
- Type-check gate: `npx tsc --noEmit -p .` reports 18 errors before this plan, 5 of them in `main.ts` and 2 in `slack-service.ts`. A task adds none, in any file.
- `npm run lint` passes at the end of every task.
- Every `check:*` script passes at the end of every task. The tmux checks need the sandbox off.
- New modules use `.ts` in relative imports, so the check scripts can import them under plain Node. Existing files keep their own import style.
- Drop a `mainWindow`/`win` parameter as soon as nothing in its function uses it, and stop passing it at every call site.
- Nothing under `src/claude-plugin/` changes, so there is no plugin version bump.
- Out of scope: the handler table that step 3's routing needs, the headless build, and moving the prompt scrape to `session-mirror`.

## Review Focus

1. **Quitting.** Events emitted while the window is being destroyed must not throw or log. The forwarder checks `isDestroyed()` before each send.
2. **The bell.** A task waiting for input rings once per 10 s per task, never while Bifrost is focused, and the `Notification` hook still answers `{ ok: true, debounced: true }` inside the 10 s.
3. **Disk-reclaim offer.** It still appears on focus after the window was away for `AWAY_MS` and a day has passed since the last scan.
4. **Startup order.** `restoreTasks()` runs where the startup block runs today: after `loadPersistedContexts()` and before any handler is registered and before the curator, disk-reclaim and console start.
5. **Prompt scrape.** `send_prompt` still restores a half-typed prompt and still unlocks the terminal (`TERMINAL_UNLOCK`) after the 2 s timeout.

`ipc-handlers.ts`, `main.ts` and `notification-service.ts` import Electron, so no check script can load them. Items 1–3 are checked by hand in the running app after the merge, which the user does (Task 5, Step 6). Items 4 and 5 are reviewed in the diff.

---

### Task 1: The event sink

**Files:**
- Create: `src/main/event-sink.ts`
- Create: `scripts/check-event-sink.mts`
- Modify: `package.json` (add `"check:event-sink": "node scripts/check-event-sink.mts"`)
- Modify: `src/main/main.ts` (subscribe the window forwarder)
- Modify: `CLAUDE.md` (a row for `event-sink.ts` in Key Services)

**Interfaces:**
- Produces, in `src/main/event-sink.ts`:
  - `export const BELL = 'bell'`, the event that rings for a task that wants attention, with one argument, the name to show.
  - `export type EventChannel = (typeof IPC_STREAM)[keyof typeof IPC_STREAM] | typeof BELL`
  - `export function emit(channel: EventChannel, ...args: unknown[]): void`
  - `export function subscribe(listener: (channel: EventChannel, args: unknown[]) => void): () => void`, which returns the unsubscribe.

- [ ] **Step 1: Write the failing check** `scripts/check-event-sink.mts`, in the style of the other checks (`check(name, ok, detail)`, exit 1 on failure). Two checks:

```ts
// 'every listener gets each event, and one that unsubscribed gets no more'
const a: unknown[] = [], b: unknown[] = [];
subscribe((channel, args) => a.push([channel, args]));
const leave = subscribe((channel, args) => b.push([channel, args]));
emit(IPC_STREAM.TOAST, 'hi', 5000);
leave();
emit(BELL, 'task');
// a = [[TOAST, ['hi', 5000]], [BELL, ['task']]], b = [[TOAST, ['hi', 5000]]]

// 'a listener that throws keeps the event from no other listener'
subscribe(() => { throw new Error('boom'); });
const c: unknown[] = [];
subscribe((channel) => c.push(channel));
emit(IPC_STREAM.TOAST, 'x');   // must not throw
// c ends with TOAST
```

- [ ] **Step 2: Run it.** `node scripts/check-event-sink.mts`. Expected: fails to import `../src/main/event-sink.ts`.

- [ ] **Step 3: Implement `src/main/event-sink.ts`.** `emit` calls each listener in subscription order inside `try`/`catch`, and logs a throw with `console.error('[events] listener failed on', channel, err)`.

- [ ] **Step 4: Run it.** Expected: `all checks passed`.

- [ ] **Step 5: Forward events to the window.** In `main.ts`, right after `createWindow()` in `app.whenReady`, subscribe a listener that sends to the current window. It reads the module's `mainWindow` at send time, so a window created again on `activate` gets the events:

```ts
subscribe((channel, args) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
});
```

- [ ] **Step 6: Verify and commit.** `npm run lint` passes, tsc still reports 18 errors. Run `comment-discipline-pass` on the CLAUDE.md row and any comments.

```bash
git add src/main/event-sink.ts scripts/check-event-sink.mts package.json src/main/main.ts CLAUDE.md
git commit -m "feat: an event sink that carries the main process's events to whoever listens"
```

### Task 2: Sessions reach the window through the sink

**Files:**
- Modify: `biome.json` (the boundary, scoped to this task's files)
- Modify: `src/main/session-manager.ts`, `src/main/console-service.ts`
- Modify (callers): `src/main/ipc-handlers.ts`
- Modify: `scripts/check-tmux-sessions.mts`

**Interfaces:**
- Consumes: `emit`, `subscribe` (Task 1).
- Produces, in `session-manager.ts`, with each signature as today minus the window parameter:
  - `attachLocalSession(sessionId, options)`
  - `createRemoteSession(sessionId, host, options)`
  - `createShellSession(sessionId, cwd, options)`
  - `attachSession(sessionId, cols, rows): Promise<boolean>`
- Produces, in `console-service.ts`: `initConsole(): void`.

- [ ] **Step 1: Add the boundary to `biome.json`** as two `overrides` entries. The first `includes` lists only the files converted so far. Task 5 widens it to `src/main/**`.

```json
"overrides": [
  {
    "includes": ["src/main/session-manager.ts", "src/main/console-service.ts"],
    "linter": { "rules": { "style": { "noRestrictedImports": { "level": "error", "options": {
      "paths": { "electron": "Only the window side imports Electron. A service reaches the window through event-sink.ts." },
      "patterns": [{ "group": ["./main", "./main.ts", "./ipc-handlers*", "./notification-service*", "./slack-service*"],
                     "message": "Only the window side imports the window side." }]
    } } } }
  },
  {
    "includes": ["src/main/main.ts", "src/main/ipc-handlers.ts", "src/main/notification-service.ts", "src/main/slack-service.ts"],
    "linter": { "rules": { "style": { "noRestrictedImports": "off" } } }
  }
]
```

- [ ] **Step 2: Run** `npx biome lint src/main/session-manager.ts src/main/console-service.ts`. Expected: `noRestrictedImports` on each file's `electron` import.

- [ ] **Step 3: Convert.**
  - In `session-manager.ts`, `send`, `ended` and `announceIdle` call `emit` with the channel and arguments they pass to `webContents.send` today. Every function that took a window loses the parameter.
  - In `console-service.ts`, the module drops `mainWindow` and the guard on it in `spawn()`, so the console respawns for as long as the process runs. Ruling: a console that keeps itself reachable is right for the IDE and for a headless instance alike.
  - Update the callers, all in `ipc-handlers.ts`.

- [ ] **Step 4: Update `scripts/check-tmux-sessions.mts`.** The fake `win` goes, and a `subscribe` listener pushes `{ channel, id: args[0], data: args[1], replay: args[2] }` into `events`. The checks' assertions stay as they are.

- [ ] **Step 5: Verify.**
  - The Step 2 lint command is clean, and `npm run lint` passes.
  - tsc still reports 18 errors.
  - `npm run check:tmux-sessions`, `check:tmux-control`, `check:mirror`, `check:terminal-io` and `check:sessions` pass, with the sandbox off.

- [ ] **Step 6: Commit.**

```bash
git commit -am "refactor: sessions reach the window through the event sink"
```

### Task 3: Watchers and the change feed through the sink

**Files:**
- Modify: `src/main/activity-watcher.ts`, `src/main/claude-watcher.ts`, `src/main/change-feed-service.ts`
- Modify (callers): `src/main/ipc-handlers.ts`
- Modify: `biome.json` (add the three files to the first override's `includes`)
- Modify: `scripts/check-worktree-scan.mts`

**Interfaces:**
- Produces:
  - `startWatching(taskId, worktreePath, claudeCallbacks?, sessionId?)`
  - `startClaudeWatching(taskId, worktreePath, callbacks?, sessionId?)`
  - `pollChangeFeed(taskId, worktreePath, lines, sessionId)`
  - `initChangeFeed(): void`

- [ ] **Step 1: Add the three files to the boundary's `includes`.**
- [ ] **Step 2: Run** `npx biome lint` on the three files. Expected: `noRestrictedImports` on each.
- [ ] **Step 3: Convert.** Each `webContents.send` becomes `emit`. `feedWindow` and every window parameter go.
- [ ] **Step 4: Update `scripts/check-worktree-scan.mts`.** It calls `initChangeFeed()` and takes the items from a `subscribe` listener on `IPC_STREAM.CHANGE_FEED_ITEMS` (`args[1]`), in place of the fake `sink`.
- [ ] **Step 5: Verify.**
  - The Step 2 lint command is clean, and `npm run lint` passes.
  - tsc still reports 18 errors.
  - Every `check:*` passes. Delete `~/.bifrost/feed/t.jsonl` before `check:worktree-scan`, since that check keeps its journal there.
- [ ] **Step 6: Commit** `refactor: watchers and the change feed reach the window through the event sink`.

### Task 4: The task logic moves to task-service

**Files:**
- Create: `src/main/task-service.ts`. It holds the task list and the operations on tasks that the IPC handlers, the HTTP API and the background services share.
- Modify: `src/main/ipc-handlers.ts`, which keeps only `registerIpcHandlers` and what Electron needs.
- Modify (importers): `src/main/bifrost-api.ts`, `src/main/curator-service.ts`, `src/main/disk-reclaim-service.ts`, `src/main/prompt-sender.ts`
- Modify: `biome.json` (add `src/main/task-service.ts` to the boundary's `includes`)
- Modify: `CLAUDE.md` (a row for `task-service.ts`, and the `ipc-handlers.ts` row becomes "Registers the IPC handlers")

**Interfaces:**
- Produces, in `task-service.ts`:
  - Every export `ipc-handlers.ts` has today except `registerIpcHandlers` and `broadcastRepos`. `createTaskCore(params, target?)`, `transferTaskCore(taskId, machine)`, `restoreTaskSession(taskId)` and `reopenTaskCore(taskId)` lose their window parameter.
  - New, from today's handler bodies:
    - `restoreTasks(): void`. This is the startup block of `registerIpcHandlers`: load the tasks, seed turn boundaries, set the permission manager's worktree resolver, set the claude-watcher callbacks, and apply `planRestore`. Its `onSummary` emits `TASK_SUMMARY`.
    - `reorderTasks(taskIds: string[]): void`
    - `resumeClaudeSessionCore(externalSessionId: string, cwd: string): Promise<Task>`
    - `regenerateTaskTitleCore(taskId: string): Promise<{ task: Task; renamedBranch: string | null } | null>`
  - Exported from what is private today: `destroyTask(taskId: string): Promise<void>`, `resolveBaseBranch(task: Task)`.
- `broadcastRepos` goes. Its callers call `emit(IPC_STREAM.REPOS_CHANGED, repos)`.

- [ ] **Step 1: Move.**
  - Move everything above `registerIpcHandlers` into `task-service.ts`, and add `src/main/task-service.ts` to the boundary's `includes`.
  - The `REORDER_TASKS`, `RESUME_CLAUDE_SESSION` and `REGENERATE_TASK_TITLE` handlers and the startup block call the new functions.
  - `LIST_TASKS`, `LIST_CLAUDE_SESSIONS` and `GET_TASK_PRS` read `getTasks()`. `pendingRestore.has(id)` becomes `isPendingRestore(id)`.
  - The remaining sends in the moved code become `emit`: `TASK_UPDATED` and the toast in `transferTaskCore`. The sends left in `registerIpcHandlers` (`WALKTHROUGH_UPDATED`, `STATS_UPDATE`) become `emit` as well, so step 3 can route them.
  - `ipc-handlers.ts` declares its own promisified `execFile`.
- [ ] **Step 2: Switch the importers** to `./task-service`. Check with `grep -n "from './ipc-handlers" src/main/*.ts`. Expected: only `main.ts`.
- [ ] **Step 3: Verify.**
  - `npx biome lint src/main/task-service.ts` is clean, and `npm run lint` passes.
  - tsc still reports 18 errors.
  - `grep -c "ipcMain\|dialog\|clipboard\|shell\." src/main/task-service.ts` prints `0`.
  - Every `check:*` passes.
- [ ] **Step 4: Run `comment-discipline-pass`** on the moved comments and the CLAUDE.md rows. A comment the move made wrong, such as one naming "the registration", gets fixed.
- [ ] **Step 5: Commit** `refactor: the task logic lives in task-service, apart from the IPC registration`.

### Task 5: Background services and the API through the sink, and the boundary on all of src/main

**Files:**
- Modify: `src/main/curator-service.ts`, `src/main/disk-reclaim-service.ts`, `src/main/prompt-sender.ts`, `src/main/bifrost-api.ts`
- Modify (window side): `src/main/notification-service.ts`, `src/main/ipc-handlers.ts`, `src/main/main.ts`
- Modify: `biome.json` (the first override's `includes` becomes `["src/main/**"]`)
- Modify: `CLAUDE.md` (the boundary, in Process Model)

**Interfaces:**
- Produces:
  - `initCurator(): void` and `initDiskReclaim(): void`.
  - `noteWindowBlur(): void` and `noteWindowFocus(): void` in `disk-reclaim-service.ts`. `registerIpcHandlers` wires `mainWindow.on('blur'|'focus')` to them where it calls `initDiskReclaim` today.
  - `initApi(): void`. `initPromptSender` goes.
  - `initNotificationService(window)`, unchanged, subscribes to `BELL` and calls `handleBellNotification(args[0] as string)`.
- In `bifrost-api.ts`, `ringBell(key: string, name: string): boolean` is private. It holds the 10 s per-key debounce that `isDebounced`/`markNotified` keep in `notification-service.ts` today, emits `BELL` and returns whether it rang. Its six call sites keep their present control flow, so the `Notification` hook still answers `debounced: true`.

- [ ] **Step 1: Widen the boundary** to `src/main/**`.
- [ ] **Step 2: Run** `npm run lint`. Expected: `noRestrictedImports` on `curator-service.ts`, `disk-reclaim-service.ts`, `prompt-sender.ts` and `bifrost-api.ts` (their `electron` imports, and `bifrost-api`'s import of `./notification-service`), and on nothing else.
- [ ] **Step 3: Convert.**
  - Sends become `emit`, and the window state and guards go. This includes the API's guards that answer an error when there is no window: `wake_task`, `open_task` and `transfer_task` no longer need one.
  - In `prompt-sender.ts`, the scrape emits `SCRAPE_PROMPT_REQUEST` and waits for its 2 s timeout as before. Ruling: with no window it waits the 2 s before sending, where today it sends at once. The IDE has a window whenever it serves the API, and step 3 moves the scrape to the session mirror.
- [ ] **Step 4: Verify.**
  - `npm run lint` passes.
  - tsc still reports 18 errors.
  - `grep -l "from 'electron'" src/main/*.ts` prints exactly the four window-side files.
  - Every `check:*` passes, and `npm test` passes in `tools/postmortem`.
- [ ] **Step 5: Docs and commit.**
  - Add one paragraph to CLAUDE.md's Process Model naming the window side and the event sink, and that `biome.json` enforces the boundary.
  - Run `comment-discipline-pass`.
  - Commit `refactor: the API and background services reach the window through the event sink`.
- [ ] **Step 6: By hand, after merge (the user).** Restart Bifrost from `main` and check:
  - With Bifrost in the background, a task that finishes rings once, and a second `Notification` within 10 s does not.
  - A tab shows its session and its activity log fills.
  - Quitting logs no `Object has been destroyed`.
  - Disk-reclaim cannot be forced cheaply, so it is reviewed in the diff instead.
