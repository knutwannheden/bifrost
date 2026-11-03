# Instance Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A machine with "Run Bifrost there" on has its own instance owning its tasks. The IDE hands the tasks over, shows them through the peer link, routes calls to them, and attaches their terminals over ssh.

**Architecture:** This is plan 3c-2, the switch.
- **Off by default.** Nothing changes until the user turns on `Machine.instance`.
- **On the machine.** Its `api-port` names its own instance, and the connection writes the IDE's forwarded port to `ide-port` instead. The instance starts sessions the way remote sessions start today, with the plugin directory, the first-run settings and `BIFROST_MACHINE`. It takes the preferences the IDE copies to it.
- **In the IDE.** A task there is created, or moved there, by today's scripts. Its record is then handed to the instance with `POST /import-tasks`, and forgotten here once the instance confirms. The tasks the IDE already holds for that machine are handed over the same way, the first time it connects.

The handover, before and after:

```
before: IDE db: task{machine:'perf'}  ── scripts over ssh ──▶ perf: tmux session, worktree
after:  IDE db: —                      peers['perf'] ◀── /events, /call ──▶ perf instance db: task
        IDE tab ── ssh tmux -C ──▶ perf tmux session ◀── perf instance (its own control client)
```

**Tech Stack:** TypeScript, the 3b peer link (`peers.ts`), 3c-1's `RemoteHost.ensureInstance()`, the existing remote scripts, React settings UI.

**Spec:** `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md`. The relevant sections are "Each task has one owner", "The headless instance", "Starting and updating perf's instance", "Config", "Transfer", and "Order of work" step 3, which includes moving the existing perf tasks.

## Global Constraints

- "A task's record lives in the database of the instance on the machine where it runs, and nowhere else. … The existing perf tasks move into perf's instance once." (spec)
- "The target imports it, keyed by task id, so a retry cannot create a duplicate. The source deletes its copy only after the target confirms." (spec, Transfer). The handover follows this.
- My calls:
  - The switch is a per-machine setting, off by default. Turning it on is the user's act, and the moment the tasks move.
  - A task is created or moved there by today's scripts, then handed over. That keeps repo cloning, worktrees and transcript moving as they are.
  - Perf listing the IDE's tasks waits for step 4, together with `create_task` across instances.
- Preferences copied on connect: `permissionMode`, `agentTeams`, `managePermissions`, `prompts`, and this machine's Claude `remoteControlAtStartup` (spec, Config).
- "In managed-permissions mode, an approval request falls back to Claude's own prompt at once when no window is connected." (spec)
- Type-check gate: 18 errors before this plan, and no task adds one. `npm run lint` passes. Every `check:*` passes.
- Acting on perf (turning the setting on, the first handover) is Task 8. It runs only after the user says go.

## Review Focus

1. **The handover.** The tasks are forgotten here only after `/import-tasks` answers. A failed import leaves them owned here and working as today. An import repeated after a crash finds the tasks already there.
2. **`api-port` on the machine.** For a machine with the setting on, `prepareScript` never writes it. A task the IDE still holds for that machine gets handed over at the first connect, since its hooks already reach the instance.
3. **Sessions the instance (re)starts.**
   - They carry `--plugin-dir ~/.bifrost/claude-plugin`, the `--settings` that `remoteSessionSettings` gives, and `BIFROST_MACHINE`.
   - Their permission mode is the IDE's.
   - The IDE's session id survives the handover, since `writeRemoteSession` stores it before the record leaves.
4. **Terminals.** A handed-over task's tab attaches over ssh as before, with one stream. A stop or archive routed to the instance ends the tmux session there, and the tab shows the exit.
5. **Editing a machine.** The settings form keeps `sync` and `instance` when the name or host changes. Today it drops `sync`.

---

### Task 1: The setting

**Files:** `src/shared/types.ts`, `src/renderer/components/SettingsOverlay.tsx`.

- [ ] **Step 1:** Add `Machine.instance?: boolean`, documented as "Whether that machine's own Bifrost instance owns the tasks there."
- [ ] **Step 2:** In `MachineEditor`, add a "Run Bifrost there" `ToggleSwitch` beside "Sync setup", built the same way.
- [ ] **Step 3:** The edit form's `save` writes `{ ...machines[editIdx], name, host }`, so other fields survive an edit.
- [ ] **Step 4:** Lint passes and tsc still reports 18 errors. Commit `feat: a machine can run its own Bifrost instance, off by default`.

### Task 2: Sessions an instance on another machine starts

**Files:** `src/main/remote-host.ts`, `src/main/task-service.ts`, `src/main/console-service.ts`, `src/main/bifrost-api.ts`, `scripts/check-instance-scripts.mts`.

**Interfaces:**
- `startInstanceScript(machine: string)` runs `node` with `BIFROST_MACHINE=<machine>` and `BIFROST_PLUGIN_DIR="$HOME/.bifrost/claude-plugin"`.
- `machineSession(permissionMode: string | undefined, remoteControl: boolean): { settings: Record<string, unknown>; args: string[]; env: Record<string, string> }`, in `remote-host.ts`.
  - With `BIFROST_PLUGIN_DIR` set, it gives `remoteSessionSettings(...)`, `['--plugin-dir', dir]` and `{ BIFROST_MACHINE }`.
  - Without it, which is the IDE, it gives empty values.
- `startLocalSession` and the console use it.
  - `startLocalSession` passes `config.remoteControlAtStartup === true` as `remoteControl`.
  - The console passes `true` for skip-permissions, as its `--dangerously-skip-permissions` needs.
- `/list-tasks` and `/find-task` report a task with no machine as `process.env.BIFROST_MACHINE`, so an MCP server on that machine sees its own tasks as its own.

- [ ] **Step 1: Write the failing check.** In `check-instance-scripts.mts`, start the instance with `startInstanceScript('perf')` and assert:

```ts
// 'an instance on another machine starts its sessions with the plugin and that machine's name'
// once the console runs, $HOME/.bifrost/sessions/console/run.sh contains `--plugin-dir` followed by
// $HOME/.bifrost/claude-plugin, and exports BIFROST_MACHINE=perf.
```

- [ ] **Step 2:** Run it. Expected: FAIL, since `run.sh` has no `--plugin-dir`.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass`.
  - Commit `feat: an instance on another machine starts sessions as remote sessions start`.

### Task 3: Preferences, and approvals with nobody to ask

**Files:** `src/shared/types.ts` (`BifrostConfig.remoteControlAtStartup?: boolean`), `src/main/bifrost-api.ts`, `src/main/event-sink.ts`, `scripts/check-headless.mts`.

**Interfaces:**
- `POST /preferences` with `{ permissionMode?, agentTeams?, managePermissions?, prompts?, remoteControlAtStartup? }` saves those keys into the instance's config and answers `{ ok: true }`.
- `listening(): boolean` in `event-sink.ts`.
- `/permission` answers `{}` at once when `!listening()`.

- [ ] **Step 1: Write the failing checks** in `check-headless.mts`:

```ts
// 'an instance takes the preferences it is sent'
// POST /preferences { permissionMode: 'auto-mode', managePermissions: true }; /call LOAD_CONFIG shows both.

// 'with nobody listening, an approval falls back to Claude at once'
// with managePermissions on (from the check above) and no /events subscriber, POST /permission for t1
// (cwd = its worktree, tool_name 'Bash') answers {} within 3 s.
```

- [ ] **Step 2:** Run it. Expected: both fail, with 404 on `/preferences` and the approval held.
- [ ] **Step 3:** Implement them.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass`.
  - Commit `feat: an instance takes the IDE's preferences, and lets Claude ask when nobody else can`.

### Task 4: An instance takes over tasks

**Files:** `src/main/task-service.ts`, `src/main/bifrost-api.ts`, `scripts/check-headless.mts`.

**Interfaces:**
- `importTasks(tasks: Task[], repos: Repo[]): string[]` in `task-service.ts`.
  - It merges `repos` into the config by id, with the path the sender gives.
  - It upserts each task by id, without `machine`, and saves.
  - It joins a running task's tmux session when one runs. Otherwise the task waits for its tab, as at start-up.
  - It answers the ids.
- `POST /import-tasks` with `{ tasks, repos }` answers `{ ids }`.
- `forgetTasks(ids: string[]): void` drops the tasks from this instance's list and database and leaves their worktrees and sessions alone. It is used in Task 6.

- [ ] **Step 1: Write the failing check** in `check-headless.mts`, run with `BIFROST_MACHINE=perf`.
  - Start a tmux session `t2` on the instance's server, running `sleep 60`.
  - Then:

```ts
// 'an instance takes over a task, once, and joins its running session'
// POST /import-tasks { tasks: [t2 running], repos: [{ id: 'r', … }] } answers ids ['t2'];
// posting it again leaves one t2 in /list-tasks {status:'all'}, whose row says machine 'perf';
// /wake-task t2 answers that it is already awake.
```

- [ ] **Step 2:** Run it. Expected: 404 on `/import-tasks`.
- [ ] **Step 3:** Implement it, together with `forgetTasks`.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass`.
  - Commit `feat: an instance takes over tasks it is handed, keyed by id`.

### Task 5: What the IDE needs from the peer link

**Files:** `src/main/peers.ts`, `scripts/check-peers.mts`.

**Interfaces:**
- `peerOf(taskId: string): string | undefined`
- `postToPeer(name: string, route: string, body: unknown): Promise<unknown>`, which connects first.
- `refreshPeer(name: string): Promise<void>`, which lists the peer's tasks again, caches them and emits `TASKS_CHANGED`.
- `routeCall` emits `TOAST` with `<name>: <reason>` when it fails, then rethrows. This is 3b's deferred feedback.

- [ ] **Step 1: Write the failing checks** in `check-peers.mts`:

```ts
// 'a task handed to a peer shows up there, and is known to be the peer's'
// postToPeer('b', '/import-tasks', { tasks: [t3], repos: [] }); await refreshPeer('b');
// peerTasks() has t3 marked machine 'b', and peerOf('t3') === 'b'.

// extend the 'a peer that goes away…' check: the failed routeCall emitted a TOAST naming 'b'.
```

- [ ] **Step 2:** Run it. Expected: fails to import `postToPeer`.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass`.
  - Commit `feat: the peer link hands tasks over, and a failed call says so`.

### Task 6: The IDE links instance machines and hands their tasks over

**Files:**
- Create: `src/main/instance-link.ts`. It links the machines that run their own instance and hands their tasks to them.
- Modify: `src/main/remote-host.ts`, `src/main/task-service.ts`, `src/main/main.ts`, `src/main/ipc-handlers.ts`.

**Interfaces:**
- `linkInstances(): void`, called once in `main.ts` after `startInstance()`, and again by the SAVE_CONFIG binding.
  - For each machine with `instance`, `registerPeer(name, connect)` is called. `connect` runs `ensureInstance()`, then POSTs `/preferences` to the port, then resolves to it.
  - If tasks with `machine === name` are still held here, they are handed over in the background, with a warning logged on failure.
- `handOver(machine: string, tasks: Task[]): Promise<void>`.
  - Each repo's path there is `${info.home}/${remoteClonePath(repo)}`.
  - It calls `postToPeer(machine, '/import-tasks', { tasks, repos })`, then `forgetTasks(ids)`, then `refreshPeer(machine)`.
- `prepareScript(opts)` gains `instance: boolean`. When it is set, the forwarded IDE port goes to `.bifrost/ide-port`, not `api-port`. `link()` passes `machine.instance === true`.
- `writeRemoteSession` stores the session id it chose on the task before the task is used.
- `createTaskCore` and `transferTaskCore` end with `handOver(machine, [task])` for a machine with `instance`. They answer the task with `machine` set.

- [ ] **Step 1:** Implement it. Its parts need `ssh` and are checked by hand in Task 8. Tasks 4 and 5 pin the import and the peer side.
- [ ] **Step 2: Verify.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - `check:remote-scripts` gains one assertion: `prepareScript({ …, instance: true })` writes `ide-port` and no `api-port`.
- [ ] **Step 3:** Commit `feat: the IDE hands a machine's tasks to its own instance`.

### Task 7: Terminals for a peer's tasks

**Files:** `src/main/ipc-handlers.ts`.

- [ ] **Step 1:** The ATTACH_SESSION binding handles a task `peerOf(id)` returns a name for. With no stream here yet, it calls `createRemoteSession(id, getRemoteHost(name), { name: task.name })`, then `attachSession`.
- [ ] **Step 2:** Lint passes, tsc still reports 18 errors, and every `check:*` passes. Commit `feat: a peer's task opens its terminal over ssh`.

### Task 8: Docs, review, and the switch on perf

**Files:** `CLAUDE.md`. The "Tasks on other machines" paragraphs describe both kinds of machine, and "Nothing registers a peer yet" goes.

- [ ] **Step 1:** Write the docs. Run `comment-discipline-pass`, then commit.
- [ ] **Step 2:** The final whole-branch review and its fix pass, before anything touches perf.
- [ ] **Step 3: With the user's go-ahead, by hand.**
  - Merge, restart Bifrost, and turn "Run Bifrost there" on for perf.
  - Expect the instance to come up, the perf tasks to move and keep their sessions running, and the tabs to attach.
  - Expect stop, archive and diff to run on perf, and a task created with MCP `create_task machine:perf` to land in perf's instance.
  - Expect the console to be reachable on perf.
