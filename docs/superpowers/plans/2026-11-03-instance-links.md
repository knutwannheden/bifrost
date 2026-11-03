# Instance Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Bifrost instance can reach another. It lists the other's tasks, forwards calls about them, and gets its events. Nothing uses this yet: 3c registers perf as a peer.

**Architecture:** This is plan 3b of step 3.
- **The instance side.** The IPC handlers that need no window move into `ipc-calls.ts`, a table by channel that a headless instance can run. The HTTP API gains two routes:
  - `POST /call` runs one entry of that table.
  - `POST /events` streams the instance's events.
- **The IDE side.** `peers.ts` holds the link to each other instance. It connects on demand, subscribes to the events, then fetches the task list. It re-emits the events locally, forwards the calls for that instance's tasks, and keeps the last task list on disk for when the instance is away.

For a call that names another instance's task, before and after:

```ts
// before: every handler runs here
ipcMain.handle(IPC.GET_DIFF, (_e, taskId, scope) => getDiff(...));
// after: the table entry runs where the task lives
ipcMain.handle(IPC.GET_DIFF, (_e, ...args) => routeCall(IPC.GET_DIFF, args, calls[IPC.GET_DIFF]));
// routeCall: peerOf(args[0]) ? callPeer(peer, IPC.GET_DIFF, args) : calls[IPC.GET_DIFF](...args)
```

**Tech Stack:** TypeScript, Node `http` and `fetch`, newline-delimited JSON over a held response, check scripts run with `node`.

**Spec:** `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md`. The relevant sections are "The IDE's window", "The links between instances" and "Left to the builder", which leaves the wire format to the builder.

## Global Constraints

- "This is one routing mechanism, not a change to each of the 78 handlers." (spec, The IDE's window)
- "On each connect, the IDE fetches a snapshot and then subscribes. Events from while it was disconnected are not replayed." (spec) The ruling here: subscribe first, then fetch, so that no event falls between the two.
- "For an instance not connected, the window shows its last answer, greyed out. That copy is kept on disk … It is only for display. Acting on one of its tasks connects first and then goes to the owner. When the connection fails, the action fails with it." (spec)
- Nothing changes for the user while no peer is registered, which holds until 3c.
- The API stays on loopback with no authentication (spec, Anti-goals and Non-goals).
- Type-check gate: `npx tsc --noEmit -p .` reports 18 errors before this plan, and no task adds one.
- `npm run lint` passes, including the window boundary. `ipc-calls.ts` and `peers.ts` are not window-side.
- Every `check:*` passes. The tmux checks need the sandbox off.
- A module a check loads under plain Node uses `.ts` in its relative imports.
- Out of scope, each with the step it belongs to:
  - Terminals for another instance's task, which the IDE attaches itself over ssh: 3c.
  - Starting, deploying or tunnelling to perf: 3c.
  - `create_task` and transfer across instances: step 4.
  - The other direction, where perf lists the IDE's tasks: 3c, once the tunnel exists.

## Review Focus

1. **A peer that goes away mid-call or mid-stream.** A forwarded call rejects with an error that names the machine. A dropped event stream marks the peer offline and fires `TASKS_CHANGED`. Nothing leaks a listener or a held response, on either side.
2. **Task payloads from a peer.** `TASK_CREATED` and `TASK_UPDATED` re-emitted locally carry `machine` set to the peer's name, so the renderer badges them and routes their calls back.
3. **Request ids.** `RESOLVE_PERMISSION` and `SCRAPE_PROMPT_RESPONSE` for a request a peer raised go to that peer. Otherwise an approval answered in the IDE never reaches the session asking.
4. **The table move.** Every window-free handler in the table behaves as it did. The handlers that keep the window, listed in Task 2, stay in `ipc-handlers.ts`. `devSessions` and the walkthrough state move with their handlers.
5. **The renderer.** `TASKS_CHANGED` reloads the list through `SET_TASKS`, which keeps the active task. A task whose instance is away is dimmed and says so, and acting on it fails with a toast, not a crash.

Items 4 and 5 run in Electron-only code and are reviewed in the diff. Items 1–3 are pinned by `check:peers` in Task 4.

---

### Task 1: The tmux-sessions check reads a rejoin as the renderer does

**Files:** Modify `scripts/check-tmux-sessions.mts`.

The rejoin and console checks write every `SESSION_DATA` chunk after the rejoin into a terminal. The renderer drops whatever arrives before the replay (`useTerminal.ts`, `beforeAttach`), so a live chunk that slips in first fails the check about one run in ten. That output is never shown.

- [ ] **Step 1:** Add `afterReplay(events)`, which drops the chunks before the first one with `replay === true`. Use it where the two checks build `chunks`.
- [ ] **Step 2:** Run `npm run check:tmux-sessions` 10 times. Expected: no `FAIL`.
- [ ] **Step 3:** Commit `test: the tmux-sessions check drops what the renderer drops before a replay`.

### Task 2: The window-free handlers become a table

**Files:**
- Create: `src/main/ipc-calls.ts`. It answers each IPC call that needs no window, so the renderer's calls and another instance's run the same code.
- Modify: `src/main/ipc-handlers.ts`, `CLAUDE.md` (the services table, and "To add a new IPC channel")

**Interfaces:**
- Produces, in `ipc-calls.ts`:
  - `export const calls: Partial<Record<IpcChannel, (...args: any[]) => unknown>>`, with `IpcChannel = (typeof IPC)[keyof typeof IPC]` exported from `ipc-channels.ts`.
- Task 4 defines which channels route, in `peers.ts`, because that check loads `peers.ts` under plain Node and `ipc-calls.ts` reaches every service.
  - `PER_TASK` holds the channels whose first argument is the id of the task they act on: CLOSE_TASK, STOP_TASK, ARCHIVE_TASK, IS_WORKTREE_DIRTY, REOPEN_TASK, CLEAR_INTERRUPTED, RENAME_TASK, REGENERATE_TASK_TITLE, DELETE_TASK, GET_DIFF, GET_FILE_STATUSES, GET_DIFF_STATS, GET_GIT_LOG, WALKTHROUGH_GET, WALKTHROUGH_GENERATE, WALKTHROUGH_DIFF, WALKTHROUGH_REMAP, GET_PR_URL, GET_LAST_CHANGED_FILE, GET_TOKEN_USAGE, CHANGE_FEED_LOAD, GET_SESSION_METRICS, SET_ACTIVE_TASK_ID, GET_LAST_ASSISTANT_MESSAGE, CURATOR_SET_OUTCOME, SEND_PROMPT.
  - `BY_REQUEST` holds RESOLVE_PERMISSION and SCRAPE_PROMPT_RESPONSE, whose first argument is a request id.
- Not in `PER_TASK`, and why:
  - The terminal channels (WRITE_TO_SESSION, RESIZE_SESSION, ATTACH_SESSION) and the dev-terminal channels: the IDE attaches to another machine's session itself.
  - TRANSFER_TASK: step 4.
- What stays in `ipc-handlers.ts`, because it needs the window or Electron: OPEN_URL, OPEN_IN_TERMINAL, OPEN_IN_IDE, SET_TERMINAL_TITLE, CAPTURE_CONTEXT, SELECT_DIRECTORY, READ_CLIPBOARD and SLACK_START_OAUTH. SAVE_CONFIG's table entry saves, and its binding in `ipc-handlers.ts` then restarts Slack polling.
- `devSessions`, `generatingWalkthroughs` and `walkthroughErrors` move into `ipc-calls.ts` with the handlers that use them.

- [ ] **Step 1: Move.**
  - Each window-free `ipcMain.handle(IPC.X, (_event, …args) => body)` becomes `[IPC.X]: (…args) => body` in `calls`.
  - `registerIpcHandlers` binds every entry with `ipcMain.handle(channel, (_e, ...args) => calls[channel](...args))`, except WRITE_TO_SESSION, which keeps `ipcMain.on`.
- [ ] **Step 2: Verify.**
  - `grep -c "ipcMain.handle\|ipcMain.on" src/main/ipc-handlers.ts` equals the number of window-side handlers plus one generic binding loop.
  - `node -e` over `IPC` confirms that every channel with a handler before still has one. Compare the channel lists of `git show HEAD:src/main/ipc-handlers.ts` and the new files.
  - Lint passes, including `ipc-calls.ts` against the boundary.
  - tsc still reports 18 errors.
  - Every `check:*` passes.
- [ ] **Step 3: Commit** `refactor: the IPC handlers that need no window are a table another instance can run`.

### Task 3: An instance answers calls and streams its events

**Files:**
- Modify: `src/main/bifrost-api.ts` (two routes)
- Modify: `scripts/check-headless.mts` (two checks)

**Interfaces:**
- `POST /call` with body `{ channel, args }`:
  - It answers 200 `{ result }` with `calls[channel](...args)` awaited.
  - It answers 404 `{ error }` for a channel with no entry, and 500 `{ error: message }` when the call throws.
- `POST /events`:
  - It answers 200 with `content-type: application/x-ndjson` and holds the response open.
  - It writes one line `{"channel":…,"args":[…]}\n` per event the instance emits, except SESSION_DATA and SESSION_EXIT, which belong to whoever attached.
  - When the request closes, the listener is removed.
- Consumes: `calls` (Task 2), `subscribe` (event-sink).

- [ ] **Step 1: Write the failing checks** in `scripts/check-headless.mts`, against the instance it already starts. Before starting it, the check opens the temporary home's database through `db.ts` and saves one task, `t1`, with `saveTasks`.

```ts
// 'an instance answers a call for one of its tasks'
// POST /call { channel: IPC.RENAME_TASK, args: ['t1', 'renamed'] } answers 200 with result.name === 'renamed',
// and POST /call { channel: 'no-such-channel', args: [] } answers 404.

// 'an instance streams its events to whoever subscribes'
// open POST /events, then POST /call ADD_REPO for a `git init`ed temporary repo.
// Within 5 s a line arrives with channel === IPC_STREAM.REPOS_CHANGED.
// Aborting the request leaves the instance answering /list-tasks.
```

- [ ] **Step 2: Run it.** `npm run check:headless`. Expected: the new checks fail with 404 on `/call`.
- [ ] **Step 3: Implement the two routes.** `/events` writes headers at once, subscribes, and unsubscribes on `req.on('close')`.
- [ ] **Step 4: Run it.** Expected: all four checks pass.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass` on the checks.
  - Commit `feat: an instance answers calls and streams its events over its API`.

### Task 4: Peers — another instance's tasks, events and calls

**Files:**
- Create: `src/main/peers.ts`. It links this instance to the instances on other machines, whose tasks it lists and whose calls it forwards.
- Modify: `src/shared/types.ts` (`Task.unreachable?: boolean`)
- Create: `scripts/check-peers.mts`, registered as `check:peers`

**Interfaces:**
- Produces, in `peers.ts`:
  - `PER_TASK` and `BY_REQUEST`, the sets Task 2 lists.
  - `registerPeer(name: string, connect: () => Promise<number>): void`. `connect` resolves to a loopback port where that instance's API answers. 3c supplies an ssh tunnel here.
  - `peerTasks(): Task[]`. A connected peer's tasks come live, each with `machine: name`. A peer that is not connected gives its last list from `~/.bifrost/peers/<name>.json`, each task with `unreachable: true` as well.
  - `routeCall(channel: IpcChannel, args: unknown[], local: (...args: unknown[]) => unknown): Promise<unknown>`.
    - A `PER_TASK` channel whose task belongs to a peer connects first if it has to, then goes to `/call` there.
    - A `BY_REQUEST` channel whose request id came from a peer goes to that peer.
    - Anything else runs `local`.
    - A failed connect or call rejects with `Error('<name>: <reason>')`.
  - `closePeers(): void`.
- Behaviour:
  - On connect it opens `/events` first and then calls LIST_TASKS. It caches the result on disk and emits `IPC_STREAM.TASKS_CHANGED`.
  - Each event line is re-emitted through `emit`:
    - TASK_CREATED and TASK_UPDATED get `machine: name` set on their Task, and update the peer's list.
    - TASK_CLOSED updates the status in the peer's list.
    - The request id of PERMISSION_PROMPT (`args[0].requestId`) and of SCRAPE_PROMPT_REQUEST (`args[1]`) is recorded against the peer.
  - When the stream ends, the peer is marked offline and `TASKS_CHANGED` is emitted.
- Produces, in `ipc-channels.ts`: `IPC_STREAM.TASKS_CHANGED = 'stream:tasks-changed'`, with no arguments. Task 5 adds the preload and renderer side.

- [ ] **Step 1: Write the failing check** `scripts/check-peers.mts`.
  - It builds the headless bundle and starts an instance B, as `check-headless.mts` does, with one saved task `t1`.
  - It sets this process's `HOME` to a temporary directory too, then imports `peers.ts` and calls `registerPeer('b', async () => portOfB)`.
  - Three checks:

```ts
// 'a peer's tasks come back marked with its machine, and its calls run there'
// await routeCall(IPC.RENAME_TASK, ['t1', 'x'], local) resolves to a Task named 'x' and never calls local,
// and peerTasks() then has t1 with machine === 'b' and name 'x'.

// 'a peer's events arrive here, with their tasks marked'
// subscribe locally, then POST /call ADD_REPO to B directly: a REPOS_CHANGED event is emitted here.
// A request id seen in a PERMISSION_PROMPT from B routes RESOLVE_PERMISSION to B.
// (Emit one by POSTing B's /permission for t1 without waiting for its answer.)

// 'a peer that goes away leaves its last list, greyed, and its calls fail'
// SIGTERM B: within 5 s TASKS_CHANGED is emitted, peerTasks() has t1 with unreachable === true,
// and routeCall(IPC.RENAME_TASK, ['t1', 'y'], local) rejects with a message that starts 'b:'.
```

- [ ] **Step 2: Run it.** Expected: it fails to import `peers.ts`.
- [ ] **Step 3: Implement `peers.ts`.** Read the stream with `fetch` and a line splitter. On `routeCall` for an offline peer, call `connect()` once more before giving up.
- [ ] **Step 4: Run it.** Expected: all checks pass.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass`.
  - Commit `feat: an instance links to the instances on other machines`.

### Task 5: The IDE routes calls and lists its peers' tasks

**Files:**
- Modify: `src/main/ipc-handlers.ts` (bind through `routeCall`, and LIST_TASKS adds `peerTasks()`)
- Modify: `src/main/instance.ts` (`closePeers()` in `stopInstance`)
- Modify: `src/shared/ipc-channels.ts` (`onTasksChanged` in `BifrostAPI`), `src/preload/preload.ts`, `src/renderer/App.tsx` or `context/AppContext.tsx` (on `TASKS_CHANGED`, call `listTasks()` and dispatch `SET_TASKS`)
- Modify: `src/renderer/components/TaskTab.tsx` (an unreachable task is dimmed like a stopped one, and its tooltip says `<machine> is not connected`)
- Modify: `CLAUDE.md` (a row for `peers.ts`, and a paragraph on peers in "Tasks on other machines")

- [ ] **Step 1: Bind.**
  - Each table entry is bound as `(_e, ...args) => routeCall(channel, args, calls[channel])`.
  - LIST_TASKS answers `[...getTasks(), ...peerTasks()]`.
  - A rejected routed call reaches the renderer as the error it already shows for a failed call.
- [ ] **Step 2: The renderer.** Add the stream listener and the dimming, following `.claude/rules/ipc-pattern.md` for the stream channel.
- [ ] **Step 3: Verify.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - With no peer registered, LIST_TASKS answers exactly `getTasks()`, so the IDE is unchanged until 3c.
- [ ] **Step 4: Docs and commit.**
  - Run `comment-discipline-pass`.
  - Commit `feat: the IDE routes another instance's task calls there and lists its tasks`.
