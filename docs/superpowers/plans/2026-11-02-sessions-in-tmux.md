# Sessions in tmux, attached in control mode: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Claude session, here and on other machines, runs in a tmux session on Bifrost's own tmux server, and Bifrost reads it as a tmux control-mode client. A restart of Bifrost leaves the sessions running, and every tab gets Claude's own bytes.

**Architecture:** `tmux-control.ts` speaks the control-mode protocol to one session over a child process's pipes: `tmux -C` here, `ssh … tmux -C` for another machine. `tmux-session.ts` holds the files and tmux command line a session runs from, the same on every machine. `session-manager.ts` keeps a stream per session id, backed by a control client for Claude sessions and by node-pty for dev shells. Quitting detaches the control clients, and killing a session ends its tmux session.

**Tech Stack:** Electron main process (TypeScript), tmux 3.4+ control mode, node-pty (dev shells only), `@xterm/headless` mirror, `scripts/check-*.mts` run with node's type stripping.

**Spec:** `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md`, step 1 of "Order of work".

## Global Constraints

- tmux server: `-L bifrost` on every machine, config `<base>/tmux.conf`, where base is `~/.bifrost` here and `.bifrost` relative to the home directory over SSH.
- tmux.conf gains `set -g default-terminal xterm-256color`. The tab's xterm.js reads the pane's bytes directly.
- Commands to a control client go one per line. Input goes as `send-keys -H` with at most 256 bytes per command.
- A replay covers at most 1000 lines of scrollback, the size of `session-mirror.ts`'s `SCROLLBACK`.
- tmux is spawned with `TMUX`, `TMUX_PANE` and `INHERITED_SESSION_VARS` removed from its environment. A server it starts keeps that environment for as long as it lives.
- Sessions in tmux read the API port from `~/.bifrost/api-port` and are not given `BIFROST_API_PORT`, since they outlive the port.
- Dev shells (`<taskId>-dev`) stay node-pty sessions that end with Bifrost.
- Checks that run tmux set `TMUX_TMPDIR` to a temporary directory, so they never touch a real Bifrost server, and skip when tmux is missing. They run outside the sandbox, which blocks tmux sockets.

## Review Focus

1. A session attached while Claude prints continuously shows each line exactly once in the tab. Pinned in Task 1, and again through the session manager in Task 3.
2. A session on the alternate screen, such as Claude's fullscreen renderer, comes back after a restart on the alternate screen, with the normal screen and scrollback behind it. Pinned in Task 1.
3. Archiving or stopping a task whose tmux session is running but has no client (after a restart, before its tab opens) ends that tmux session. Pinned in Task 3.
4. A task renamed while its session runs is addressed by the name the session started under, also after a restart. Pinned in Task 3.
5. A remote connection that drops reconnects, and the tab is redrawn from the new client's replay rather than left showing a stale screen. Covered by Task 5, step 4. The tab side is checked by hand.

---

### Task 1: The control-mode client

**Files:**
- Create: `src/main/tmux-control.ts`
- Create: `scripts/check-tmux-control.mts`, `package.json` script `check:tmux-control`

**Interfaces — Produces:**
```ts
export class TmuxControl {
  /** Spawns `command args` with pipes. args must make tmux attach in control mode (-C). */
  static start(command: string, args: string[], size: { cols: number; rows: number }, env?: NodeJS.ProcessEnv): TmuxControl;
  /** Terminal output that reproduces the pane at attach: scrollback, screen, alternate screen, cursor. Rejects when the client ends first. */
  readonly screen: Promise<string>;
  onOutput(listener: (data: string) => void): void; // pane output after `screen`
  onExit(listener: (code: number | null) => void): void; // the child's exit code
  write(data: string): void;
  resize(cols: number, rows: number): void;
  command(line: string): Promise<string[]>; // output lines; rejects with the %error lines
  detach(): void; // closes stdin; the session runs on
  kill(): void; // kill-session; the client then ends with %exit
}
```

- [ ] **Step 1: Write the failing checks** in `scripts/check-tmux-control.mts`. Each starts its own session with `tmux -L bifrost-check -f <conf> -C new-session -A -s <name> -x 80 -y 10 sh -c <program>` under a temporary `TMUX_TMPDIR`.
  - `the client receives the pane's bytes exactly`: the program prints `héllo \e[31mred\e[0m \e]8;;https://example.com\e\\link\e]8;;\e\\\r\n` with `printf`. The concatenated output contains that string verbatim.
  - `input reaches the program intact`: `write('aé\\b\r')` to a program doing `read x; printf 'got:%s\n' "$x"`. The output contains `got:aé\b`.
  - `a client joining a busy session shows every line once`: the program prints `n<i>` every 5 ms. Detach a first client and start a second. Write `await screen` and then all output into a headless 80x10 xterm with scrollback 1000. The `n<i>` lines in its buffer are consecutive integers with no repeat and no gap.
  - `a session on the alternate screen comes back on it`: the program prints `normal-1`..`normal-3`, then `\e[?1049h` and `alt-screen`, and sleeps. A second client's `screen`, written to a headless xterm, leaves `buffer.active.type === 'alternate'` showing `alt-screen`. Writing `\e[?1049l` afterwards shows `normal-3` on the normal buffer.
  - `resizing sets the pane's size`: after `resize(90, 15)`, `command("display -p '#{pane_width}x#{pane_height}'")` answers `['90x15']`.
  - `detaching leaves the session running and ending it ends the client`: after `detach()`, `tmux has-session -t =<name>` succeeds. After a new client's `kill()`, `onExit` fires once and `has-session` fails.

- [ ] **Step 2: Run them and see them fail**

Run: `node scripts/check-tmux-control.mts` (outside the sandbox).
Expected: fails to import `../src/main/tmux-control.ts`.

- [ ] **Step 3: Implement `TmuxControl`.**
  - Read stdout as bytes and split on `\n`.
  - `%output %<pane> <data>`: turn each `\ooo` into its byte and pass other bytes through. Decode with one streaming `TextDecoder('utf-8')`, since a character can straddle two lines.
  - `%begin`/`%end`/`%error` with flags bit 1 answer the oldest pending command. Blocks with flags 0, from the attaching command, answer nothing. Other `%` lines are ignored.
  - At start, write one line, which tmux runs without reading the pane in between: `refresh-client -C <cols>x<rows> ; display -p '#{cursor_x} #{cursor_y} #{alternate_on} #{history_size} #{pane_height}' ; capture-pane -p -e -a -q ; capture-pane -p -e -S -1000`.
  - Drop `%output` until the last block of that line has ended, since the captures hold it.
  - Build the replay from the second capture's lines, joined with `\r\n`:
    - On the normal screen, the replay is those lines, then `\e[0m` and the cursor as `\e[<y+1>;<x+1>H`.
    - On the alternate screen, the replay starts with the scrollback, which is the second capture's lines short of the last `pane_height`. Then come the first capture's lines, which are the normal screen set aside, then `\e[?1049h\e[H`, the last `pane_height` lines, and the cursor.
  - `write` splits the UTF-8 bytes into commands of at most 256: `send-keys -H 61 c3 a9`.

- [ ] **Step 4: Run them and see them pass**

Run: `node scripts/check-tmux-control.mts` (outside the sandbox).
Expected: `all checks passed`.

- [ ] **Step 5: Lint, typecheck, run the test-discipline pass over the new checks, then commit**

```bash
npx biome check src/main/tmux-control.ts scripts/check-tmux-control.mts package.json && npm run typecheck
git add src/main/tmux-control.ts scripts/check-tmux-control.mts package.json
git commit -m "feat: a tmux control-mode client for one session"
```

---

### Task 2: One session layout for every machine

**Files:**
- Create: `src/main/tmux-session.ts`
- Modify: `src/main/remote-host.ts` (move out `TMUX_SOCKET`, `TMUX_CONF`, `sessionDir`, `RemoteSessionSpec`. `sessionSetupScript` builds on `sessionFiles`. Drop `attachCommand` and attach.sh. `prepareScript` writes `tmuxConf()`.)
- Modify: `scripts/check-remote-scripts.mts`

**Interfaces — Produces:**
```ts
export const TMUX_SOCKET = 'bifrost';
export function tmuxConf(): string; // TMUX_CONF lines plus default-terminal xterm-256color
export function sessionDir(taskId: string): string; // `.bifrost/sessions/<id>`, relative to home
export interface SessionSpec { home: string; taskId: string; worktreePath: string; sessionId: string; claudeArgs: string[]; env: Record<string, string>; prompt?: string }
export function sessionFiles(spec: SessionSpec): Record<string, string>; // name in the session dir -> content: session-id, run.sh, prompt?
export function controlArgs(base: string, taskId: string, cols: number, rows: number): string[];
// ['-u','-L','bifrost','-f',`${base}/tmux.conf`,'-C','new-session','-A','-s',taskId,'-x',`${cols}`,'-y',`${rows}`,'sh',`${base}/sessions/${taskId}/run.sh`]
export function writeLocalSession(spec: SessionSpec): void; // ~/.bifrost/tmux.conf and the session files, and trusts the worktree
export function writeLocalSessionId(taskId: string, sessionId: string): void;
export function startedName(taskId: string): string | undefined; // the name the live local session started under
export function localTmuxEnv(): NodeJS.ProcessEnv; // process.env without TMUX, TMUX_PANE and INHERITED_SESSION_VARS
export function endLocalSession(taskId: string): void; // kill-session, synchronous; no session is fine
```

- [ ] **Step 1: Change the checks in `check-remote-scripts.mts`.**
  - Run the attach as `sh -c` of `controlArgs('.bifrost', taskId, 80, 24).join(' ')` prefixed with `tmux`, in HOME. That is how ssh's login shell gets it.
  - The stub tmux's `new-session` parser skips `-x` and `-y`, and leaves out `-c`, since run.sh changes directory itself.
  - Keep the four existing attach checks.
  - Add `a transcript under CLAUDE_CONFIG_DIR is resumed`: the transcript sits in `$CLAUDE_CONFIG_DIR/projects/x/<sid>.jsonl` and HOME has none. The attach passes `--resume <sid>`.
  - Add `run.sh records the name the session started under`: after the first attach, `<home>/.bifrost/sessions/<id>/started-name` holds the awkward name.

- [ ] **Step 2: Run them and see them fail**

Run: `node scripts/check-remote-scripts.mts` (outside the sandbox).
Expected: an import error for `controlArgs`, then a FAIL for each new check.

- [ ] **Step 3: Implement `tmux-session.ts` and change `remote-host.ts`.**
  - run.sh looks for the transcript under `"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$sid".jsonl`.
  - Before starting Claude, run.sh writes `"$BIFROST_SESSION_NAME"` to `"$d/started-name"`.
  - `sessionSetupScript` prints each of `sessionFiles` with `printf '%s\n'`, after the trust line.
  - `writeLocalSession` writes each one with `fs`, mode 0o644, and calls `trustDirectory`.
  - `endLocalSession` runs `tmux -L bifrost kill-session -t =<id>` with `localTmuxEnv()` and ignores a failure.

- [ ] **Step 4: Run them and see them pass**, along with `check:task-transfer` and `check:remote-sync`, which import from `remote-host.ts`.

- [ ] **Step 5: Lint, typecheck, test-discipline pass, commit:** `refactor: a task session runs from the same files and tmux command on every machine`

---

### Task 3: Local sessions in tmux

**Files:**
- Modify: `src/main/session-manager.ts`
- Create: `scripts/check-tmux-sessions.mts`, `package.json` script `check:tmux-sessions`

**Interfaces:**
- Consumes: `TmuxControl` (Task 1), `controlArgs`, `localTmuxEnv`, `endLocalSession`, `startedName` (Task 2).
- Produces:
```ts
/** Starts the session writeLocalSession set up, or joins it where it still runs. */
export function attachLocalSession(sessionId: string, mainWindow: BrowserWindow, options: { name?: string; taskId?: string }): void;
/** Ends every session's stream. Sessions in tmux run on, and dev shells end. */
export function detachAllSessions(): void;
// Unchanged signatures, new meaning:
export function killSession(sessionId: string): void; // also ends a local tmux session no client holds
export function attachSession(...): Promise<boolean>; // waits for the replay before the snapshot
```
`createSession` and its prompt-file piping go. `claudeArgs` and `claudeEnv` stay. `spawnSession` stays for dev shells.

- [ ] **Step 1: Write the failing checks** in `scripts/check-tmux-sessions.mts`.
  - Setup: HOME and `TMUX_TMPDIR` are temporary directories. A stub `claude` on PATH prints a numbered line every 20 ms, echoes what it reads, and prints one OSC 8 link at start. The window is `{ isDestroyed: () => false, webContents: { send(channel, ...args) { /* record */ } } }`. Files come from `writeLocalSession`.
  - `a tab gets the session's own bytes`: the recorded `SESSION_DATA` holds the stub's OSC 8 sequence verbatim.
  - `a session outlives detaching, and rejoining replays it once`: `detachAllSessions()`, then wait 200 ms, then `attachLocalSession` and `attachSession(id, win, 80, 10)`. Write the replay and all later data into a headless xterm. Its numbered lines are consecutive, with no repeat, and continue past the last number seen before detaching.
  - `killing a session nobody is attached to ends its tmux session`: after `detachAllSessions()`, `killSession(id)` makes `tmux -L bifrost has-session -t =<id>` fail.
  - `a session ending reports its exit once`: the stub exits on input `q\r`. `SESSION_EXIT` is recorded once for the id.
  - `a rejoined session keeps the name it started under`: start with name `old`, detach, rewrite the files with name `new`, and rejoin. `getSessionName(id) === 'old'`.
  - `attaching a session twice leaves one stream`: call `attachLocalSession` twice for one id and write `x\r`. The stub's echo of `x` reaches `SESSION_DATA` once. This is the doubled-input bug of 2026-11-01.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - Keep the stream interface private: `{ write, resize, detach, kill }`.
  - Wire node-pty and `TmuxControl` streams through one function that feeds the mirror, the startup buffer, the ready gate and the window. That is what `spawnSession`'s `onData`/`onExit` do today.
  - A tmux stream creates its mirror at the size it asked for. It writes `await screen` into the mirror and into the startup buffer without forwarding it, and calls `noteSessionOutput`, so an idle session that is rejoined turns ready after `READY_QUIET_MS`.
  - `attachSession` awaits that before `snapshotMirror`.
  - `attachLocalSession` sets `sessionNames` from `startedName(id) ?? options.name`.
  - `killSession`: `stream ? stream.kill() : endLocalSession(id)`.
  - Starting a stream for an id that has one detaches the old one first. Output and exit from a replaced stream are ignored, by comparing it with `sessions.get(id)`.
  - `SESSION_EXIT` carries 0 for a session tmux ended.

- [ ] **Step 4: Run `check:tmux-sessions`, `check:mirror` and `check:terminal-io` and see them pass.**

- [ ] **Step 5: Lint, typecheck, test-discipline pass, commit:** `feat: a session on this machine runs in tmux and outlives Bifrost`

---

### Task 4: Tasks here start, rejoin and stop through tmux

**Files:**
- Modify: `src/main/ipc-handlers.ts`, `src/main/bifrost-api.ts`, `src/main/main.ts`, `src/main/disk-reclaim-service.ts`

**Interfaces — Consumes:** `writeLocalSession`, `writeLocalSessionId` (Task 2), `attachLocalSession`, `detachAllSessions` (Task 3).

- [ ] **Step 1: Add `startLocalSession(task: Task, mainWindow: BrowserWindow, prompt?: string): Task` to `ipc-handlers.ts`.**
  - It gives the task a `sessionId` (`randomUUID()`) when it has none, and records it.
  - It writes the files with `claudeArgs(launch)` and `claudeEnv(launch)`, where `launch` has no `apiPort`.
  - It then attaches.
  - `createTaskCore` and `createMultiRepoTask` build the task first, start its session, then push it.
  - `restoreTaskSession` and `reopenTaskCore` call it after their stale-session check. Their `onResumeFailed` goes, since run.sh starts afresh under the same id.

- [ ] **Step 2: Make the session-start hook in `bifrost-api.ts` call `writeLocalSessionId` for a task on this machine,** as it calls `sessionIdScript` for one elsewhere. This is so a later start resumes the session a `/clear` began.

- [ ] **Step 3: Quitting detaches.**
  - `main.ts` calls `detachAllSessions()` in place of `killAllSessions()`.
  - `markSessionsInterrupted` and its call go. A quit no longer cuts a turn off. The banner keeps showing records written before.

- [ ] **Step 4: Disk reclaim counts a running task as live.** Its session can run in tmux with no client: `hasLiveSession: hasSession(task.id) || task.status === 'running'`.

- [ ] **Step 5: Verify.** Run `npm run typecheck`, `npm run lint` and every `check:*` script that imports `ipc-handlers.ts` or `bifrost-api.ts`, and expect them all to pass. Then run the test-discipline pass.

- [ ] **Step 6: Commit:** `feat: a task here keeps running in tmux across a restart of Bifrost`

---

### Task 5: Remote sessions in control mode

**Files:**
- Modify: `src/main/remote-host.ts` (`ptyArgs` becomes `controlArgs(taskId, cols, rows)`), `src/main/session-manager.ts` (`createRemoteSession`)

**Interfaces — Produces:** `RemoteHost.controlArgs(taskId: string, cols: number, rows: number): string[]`. It returns `[...sshOptions(), '-T', '-o', 'BatchMode=yes', host, ['tmux', ...controlArgs('.bifrost', taskId, cols, rows)].join(' ')]`. Every token is safe for any login shell.

- [ ] **Step 1:** `createRemoteSession` starts a `TmuxControl` on `ssh` with those arguments. The existing retry policy stays: exit 255 is a lost connection, retried on `RECONNECT_DELAYS_MS`.
- [ ] **Step 2:** On a reconnect, the new client's replay goes to the tab as live data after `\x1bc`, since the tab is showing the screen from before the drop. The mirror is rebuilt from the same replay.
- [ ] **Step 3:** `killSession` on a remote stream sends `kill-session` through it. `stopTaskSession` keeps its script for the session no client holds.
- [ ] **Step 4: Verify.**
  - Run `npm run typecheck`, `check:remote-scripts` and `check:task-transfer`.
  - By hand, open a perf task's tab and confirm the screen, input, a link and the colours. Restart Bifrost and confirm the same tab comes back.
  - Kill the ssh client process (`pkill -f 'tmux.*-C.*<taskId>'` on this machine) and confirm the tab redraws after the reconnect.
- [ ] **Step 5: Commit:** `feat: a tab on another machine reads its session in tmux control mode`

---

### Task 6: The console in tmux

**Files:**
- Modify: `src/main/console-service.ts`

- [ ] **Step 1:** On every start, `spawn()` writes the console's files with `writeLocalSession`. The spec is `taskId: 'console'`, `worktreePath: CONSOLE_DIR`, a fresh `sessionId`, and `claudeArgs: ['--name', CONSOLE_NAME, '--dangerously-skip-permissions']`. The env is `BIFROST_CONTEXT=console` and `BIFROST_SESSION_NAME=bifrost`. It then calls `attachLocalSession`.
  - A console that is still running is joined. A fresh one starts with no transcript.
  - Its exit schedules the respawn, as today.
- [ ] **Step 2:** `resetConsole` calls `killSession(CONSOLE_SESSION_ID)`, which ends the tmux session, and starts again.
- [ ] **Step 3: Verify.** Run `npm run typecheck`. Then extend `check:tmux-sessions` with `a console started again joins the one still running`: two `spawn` calls with a detach between leave one tmux session, with the stub's line numbers continuing.
- [ ] **Step 4: Commit:** `feat: the console runs in tmux and stays reachable across a restart`

---

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md`, `scripts/restart-bifrost.sh` (header comment only)

- [ ] **Step 1: Update `CLAUDE.md`.**
  - Key services table: rows for `tmux-control.ts` and `tmux-session.ts`, and the `session-manager.ts` row.
  - "Tasks on other machines": the tab is a control client over ssh.
  - "Restarting Bifrost from a task": a restart leaves task sessions and the console running in tmux, and ends dev terminals. Waking a session rejoins it.
- [ ] **Step 2: Run the comment-discipline pass over every comment and doc passage on the branch since `516c646`.**
- [ ] **Step 3: Commit:** `docs: sessions run in tmux on every machine`
