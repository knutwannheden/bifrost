# Headless Instance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bifrost instance runs as a plain Node process, with the same services the IDE runs, and nothing changes in the IDE.

**Architecture:** Step 3 of the design comes in three plans:
- **3a, this plan:** an instance runs without Electron.
- **3b:** instances route calls and events to one another, and the IDE lists another instance's tasks.
- **3c:** perf runs its own instance, deployed and started by the IDE, and perf's tasks move into it.

This plan has three parts:
- The database moves from `better-sqlite3`, a native module built for Electron, to Node's own `node:sqlite`. It works in Electron 43 (Node 24.18) and on perf (Node 24.22).
- `instance.ts` starts and stops the services an instance runs, and `main.ts` calls it.
- `headless.ts` is a second entry point. It starts an instance and stops it on SIGTERM, and Vite builds it for plain Node.

Before and after, for how the IDE starts its services:

```ts
// before: main.ts, with the service start-up inside registerIpcHandlers
await startApi(); openDatabase(); registerIpcHandlers(mainWindow); initNotificationService(mainWindow); initApi(); startPolling(mainWindow);
// after
await startInstance(); registerIpcHandlers(mainWindow); initNotificationService(mainWindow); startPolling(mainWindow);
```

**Tech Stack:** TypeScript, `node:sqlite` (`DatabaseSync`), Vite 5 library build for Node, tmux, standalone check scripts run with `node`.

**Spec:** `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md`, section "The headless instance" and step 3 of "Order of work". The spec leaves `node:sqlite` or `better-sqlite3` for Node to the builder.

## Global Constraints

- "The IDE's instance and a headless instance run the same code." (spec, Goals)
- Nothing changes in what the IDE does. Its start-up order stays: API, database, change feed, contexts, `restoreTasks()`, IPC handlers, curator, console, then notifications, `initApi()` and Slack.
- The user's database at `~/.bifrost/bifrost.db` (schema version 8, WAL) opens as it is, with no migration.
- Type-check gate: `npx tsc --noEmit -p .` reports 18 errors before this plan. A task adds none.
- `npm run lint` passes, including the window boundary in `biome.json`. `instance.ts` and `headless.ts` are not window-side.
- Every `check:*` script passes. The tmux checks need the sandbox off.
- A module a check script loads under plain Node uses `.ts` in its relative imports. `import type` lines may stay extensionless, since Node strips them.
- Out of scope: routing calls and events between instances, deploying to perf, and dev terminals in a headless instance.

## Review Focus

1. **The existing database.** The real `~/.bifrost/bifrost.db` (version 8, WAL, with `-wal`/`-shm` beside it) opens under `node:sqlite` with every task, context and note intact.
2. **Bound values.** Both libraries refuse `undefined` and booleans. Every write in `task-store`, `context-store`, `note-store` and `slack-service` must still pass only numbers, strings or null. `node:sqlite` has no typed `prepare<…>` generics, so the casts move to the call sites.
3. **IDE start-up order.** `startInstance()` keeps the order the IDE has today. In particular, `restoreTasks()` runs before the IPC handlers register and before the curator and console start.
4. **Quitting the IDE.** `before-quit` still stops the watchers, detaches the sessions, closes the SSH masters, stops the API and closes the database, in that order, now through `stopInstance()`.
5. **Packaging.** `forge.config.ts` and `vite.main.config.mts` stop naming `better-sqlite3`, and nothing else still imports it.

Item 1 is checked by hand. Before Task 1's commit, the executor copies the real database to a temporary home and opens it through `db.ts` (Task 1, Step 5). Items 3 and 4 live in `main.ts`, which no check loads, so they are reviewed in the diff.

---

### Task 1: The database on node:sqlite

**Files:**
- Modify: `src/main/db.ts`, `src/main/task-store.ts`, `src/main/context-store.ts`, `src/main/note-store.ts`, `src/main/slack-service.ts`
- Modify: `package.json` (remove `better-sqlite3` and `@types/better-sqlite3`), `package-lock.json` (by `npm uninstall`), `forge.config.ts` and `vite.main.config.mts` (stop naming `better-sqlite3`)
- Create: `scripts/check-database.mts`, registered as `check:database`

**Interfaces:**
- Produces, in `db.ts`:
  - `getDb(): DatabaseSync`
  - `transaction<T>(fn: () => T): T`, which runs `fn` between `BEGIN` and `COMMIT`, and rolls back and rethrows when it throws.
  - `openDatabase()` and `closeDatabase()`, unchanged.

- [ ] **Step 1: Write the failing check** `scripts/check-database.mts`. It sets `HOME` to a temporary directory before a dynamic `import('../src/main/db.ts')`, since `db.ts` fixes its path as it loads. Two checks:

```ts
// 'tasks come back from the store as they were saved'
// saveTasks([a, b]) then loadTasks() deep-equals [a, b], where a has every optional
// field set (booleans true, numbers, machine, createdByTaskId) and b has none.

// 'a transaction that throws leaves nothing behind'
// transaction(() => { createNote('r', 'n'); throw new Error('x'); })
// throws 'x', and listNotes('r') is still [].
```

- [ ] **Step 2: Run it.** `node scripts/check-database.mts`. Expected: it fails to load `db.ts`. Either an extensionless relative import cannot be resolved, or `better-sqlite3` refuses to load under plain Node (`NODE_MODULE_VERSION`).
- [ ] **Step 3: Implement.**
  - `db.ts` opens `new DatabaseSync(DB_PATH)` and runs the two pragmas through `exec`. Its migrations call `transaction`.
  - The stores replace `d.transaction(fn)()` with `transaction(fn)` and cast query results at the call site.
  - `db.ts`, `task-store.ts`, `note-store.ts` and `context-store.ts` take `.ts` relative imports, and so does any module they import that the check needs.
  - Run `npm uninstall better-sqlite3 @types/better-sqlite3`.
- [ ] **Step 4: Run it.** Expected: `all checks passed`.
- [ ] **Step 5: Open the real database, read-only in effect.** Copy `~/.bifrost/bifrost.db*` to a temporary home and open it through `db.ts` there. Expected: `loadTasks().length` equals `sqlite3 ~/.bifrost/bifrost.db 'select count(*) from tasks'`.
- [ ] **Step 6: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - `grep -rn better-sqlite3 src forge.config.ts vite.main.config.mts package.json` prints nothing.
  - Run `test-discipline-pass` on the new check.
  - Commit `refactor: the database runs on node:sqlite, which Electron and plain Node both have`.

### Task 2: One module starts and stops an instance

**Files:**
- Create: `src/main/instance.ts`. It starts and stops the services a Bifrost instance runs, with or without a window.
- Modify: `src/main/main.ts`, `src/main/ipc-handlers.ts`
- Modify: `CLAUDE.md` (a row for `instance.ts`)

**Interfaces:**
- Produces, in `instance.ts`:
  - `startInstance(): Promise<void>`. In order: `startApi()`, `openDatabase()`, `initChangeFeed()`, `loadPersistedContexts()`, `restoreTasks()`, `initCurator()`, `initConsole()`, `initApi()`.
  - `stopInstance(): Promise<void>`. In order: `stopAllWatching()`, `detachAllSessions()`, `closeRemoteHosts()`, `stopApi()`, `closeDatabase()`.
- `registerIpcHandlers(mainWindow)` keeps only handler registration and the window's blur and focus wiring.
- Ruling to carry: today the curator and console start after the IPC handlers register. They now start before. Neither reads anything the handlers set up, and the review checks that.

- [ ] **Step 1: Move the start-up and quit sequences** into `instance.ts` and call them from `main.ts` (`app.whenReady` and `before-quit`). `ensureHooks()`, the menu, the window, the forwarder, notifications and Slack stay in `main.ts`.
- [ ] **Step 2: Verify.**
  - Lint passes, including `instance.ts` against the boundary.
  - tsc still reports 18 errors.
  - Every `check:*` passes.
- [ ] **Step 3: Docs and commit.** Run `comment-discipline-pass`, then commit `refactor: one module starts and stops an instance's services`.

### Task 3: The headless entry and its build

**Files:**
- Create: `src/main/headless.ts`
- Create: `vite.headless.config.mts`, a library build of `src/main/headless.ts` for Node into `.vite/headless/headless.js`, with `node-pty`, `@parcel/watcher` and Node's builtins external.
- Modify: `package.json` (`"build:headless": "vite build -c vite.headless.config.mts"`, and `check:headless`)
- Create: `scripts/check-headless.mts`
- Modify: `CLAUDE.md` (Commands: `build:headless`, and one sentence in Process Model on the headless entry)

**Interfaces:**
- Consumes: `startInstance`, `stopInstance` (Task 2).
- Produces: `node .vite/headless/headless.js` runs an instance until SIGTERM or SIGINT, then calls `stopInstance()` and exits 0.

- [ ] **Step 1: Write the failing check** `scripts/check-headless.mts`. It runs `npm run build:headless`, then starts `node .vite/headless/headless.js` with `HOME` and `TMUX_TMPDIR` in a temporary directory and a stub `claude` first on `PATH`, as `check-tmux-sessions.mts` does. Two checks:

```ts
// 'an instance comes up without Electron and serves its API'
// within 15 s, $HOME/.bifrost/api-port exists, and POST /list-tasks on that port answers 200 with [].

// 'stopping an instance leaves its sessions running'
// the console's tmux session ('console') runs, SIGTERM makes the process exit 0,
// and `tmux -S <socket> has-session -t =console` still succeeds afterwards.
```

- [ ] **Step 2: Run it.** `node scripts/check-headless.mts`. Expected: the build fails, since there is no `vite.headless.config.mts`.
- [ ] **Step 3: Implement** `headless.ts` and the Vite config. Fix whatever the bundle trips over at run time, such as a path built from `__dirname`, at its source, and ledger each fix as a ruling.
- [ ] **Step 4: Run it.** Expected: `all checks passed`. Then kill the check's tmux server, which the check does itself in a `finally`.
- [ ] **Step 5: Verify, docs and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - `.vite/` is already git-ignored. Confirm with `git check-ignore .vite/headless/headless.js`.
  - Run `test-discipline-pass` and `comment-discipline-pass`.
  - Commit `feat: a Bifrost instance runs headless under plain Node`.
