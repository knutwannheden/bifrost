# Remote Instance Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The IDE can ship Bifrost's headless instance to a configured machine, install it, start it, keep it current and tunnel to its API, through one call, `RemoteHost.ensureInstance()`. Nothing calls it yet.

**Architecture:** Step 3c comes in two plans.
- **3c-1, this plan, which stays dormant:** the lifecycle of an instance on another machine.
- **3c-2, the switch:** a per-machine setting makes that machine's instance own its tasks. It covers:
  - moving the existing tasks there, and the machine's `api-port` naming its own instance;
  - its link back to the IDE, and terminals for its tasks;
  - creating tasks there, preferences, and the approvals fallback.

The two can't land as one change in practice, and 3c-1 changes nothing on its own: as long as a machine's `api-port` names the IDE (through the `-R` forward), an instance started there would take over the hooks of the sessions the IDE still owns.

How `ensureInstance()` brings the instance up:

```
IDE                                   machine (~/.bifrost/instance/)
pack: build .vite/headless, hash it
status script  ───────────────────▶  INSTANCE_HASH=… INSTANCE_PORT=… (if its API answers)
plan(status, hash): none | start | install
install: tar ▶ instance.new, npm install, swap, record the hash
start: tmux -L bifrost session "instance" running `while :; do node headless.js; sleep 2; done`
ssh -O forward -L <free local port>:127.0.0.1:<INSTANCE_PORT>
◀── resolves to the local port, which 3c-2 hands to registerPeer(name, …)
```

**Tech Stack:** TypeScript, the existing `RemoteHost` (OpenSSH master, `exec`, `sendTar`), POSIX sh scripts checked against a local home, tmux, npm.

**Spec:** `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md`, section "Starting and updating perf's instance". "Left to the builder" lists the restart after a crash (a respawn loop or a window in Bifrost's tmux server) and how the build and its native modules reach the machine.

## Global Constraints

- "On connect, the IDE starts perf's instance if `~/.bifrost/api-port` there does not answer. It runs detached … and keeps running when the connection drops." (spec)
- "The IDE ships the instance's build to perf and installs its Linux native modules there. It restarts the instance when the build changes." (spec)
- "An update to perf's instance ending perf's sessions" is an anti-goal. Restarting the instance must leave every other tmux session running, and `stopInstance()` already only detaches.
- "An instance listening on anything but loopback" is an anti-goal. The forward binds to loopback on both ends.
- Nothing in the IDE calls `ensureInstance()` in this plan, so nothing changes for the user.
- My calls, which the reviewer should weigh:
  - The instance runs in a tmux session named `instance` on Bifrost's own tmux server, in a respawn loop. That gives restart after a crash, survival of a dropped connection, and visibility with `tmux -L bifrost attach -t instance`.
  - `npm install --omit=dev` on the machine installs `@parcel/watcher` for its platform. The bundle requires it as it loads.
- Type-check gate: 18 errors before this plan, and no task adds one. `npm run lint` passes. Every `check:*` passes, with the tmux checks run outside the sandbox.
- Remote scripts are POSIX `sh` built in `remote-host.ts`, like the existing ones, and are checked against a local home directory.

## Review Focus

1. **Restart leaves sessions alone.** `kill-session -t =instance` sends SIGHUP to the loop and to `node`. The instance has to stop cleanly (detach, close its DB) and must not touch the `console` or task sessions on the same server.
2. **A half-finished update.** If `npm install` fails or the connection drops mid-install, the running instance and its directory stay as they were. The new build sits in `instance.new` until the swap, and the swap is one `mv` after the install succeeds.
3. **A stale forward.** When the instance restarts on another port, or the master reconnects, the local forward follows. A second `ensureInstance()` while one is in flight joins it.
4. **The probe.** `INSTANCE_PORT` is reported only when `POST /list-tasks` on the port in `~/.bifrost/api-port` answers 200 within 2 s. A stale file or a dead port means "start it".
5. **Packing in a running IDE.** `pack()` builds with the checkout's Vite once per IDE process. The hash covers both `headless.js` and the `package.json` it ships.

---

### Task 1: An instance stops on a hang-up

**Files:** Modify `src/main/headless.ts`.

- [ ] **Step 1:** Also call `stop` on `SIGHUP`, which tmux sends when it kills the `instance` session. Task 3's restart check pins it.
- [ ] **Step 2:** Lint passes, then commit `feat: a headless instance stops on a hang-up as on SIGTERM`.

### Task 2: Packing the instance and deciding what a machine needs

**Files:**
- Create: `src/main/instance-deploy.ts`. It packs the headless instance for another machine and decides what that machine has to do to run it.
- Create: `scripts/check-instance-deploy.mts`, registered as `check:instance-deploy`.

**Interfaces:**
- `pack(checkout: string): Promise<{ dir: string; hash: string }>`
  - It runs `npm run -s build:headless` in `checkout` once per process.
  - It writes `.vite/headless/package.json` as `{ "private": true, "dependencies": { "@parcel/watcher": <the range in the checkout's package.json> } }`.
  - It returns that directory and the sha256 of `headless.js` and `package.json` together.
- `plan(status: { hash?: string; port?: number }, hash: string): 'none' | 'start' | 'install'`
  - `install` when the hashes differ.
  - Otherwise `start` when there is no port.
  - Otherwise `none`.

- [ ] **Step 1: Write the failing check.**

```ts
// 'a machine whose build differs installs, a stopped one starts, a current running one is left alone'
// plan({}, 'h') === 'install'; plan({ hash: 'h' }, 'h') === 'start'; plan({ hash: 'h', port: 1 }, 'h') === 'none';
// plan({ hash: 'old', port: 1 }, 'h') === 'install'

// 'the packed instance names its native module, and its hash follows its content'
// const a = await pack(repoRoot); package.json in a.dir names @parcel/watcher;
// a.hash === (await pack(repoRoot)).hash; appending a byte to a.dir/package.json changes hashOf(a.dir).
```

Export `hashOf(dir)` for the second case, and have `pack()` use it.

- [ ] **Step 2:** Run it. Expected: it fails to import `instance-deploy.ts`.
- [ ] **Step 3:** Implement it with `.ts` relative imports, since the check loads it under plain Node.
- [ ] **Step 4:** Run it. Expected: `all checks passed`.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass`.
  - Commit `feat: the headless instance is packed for another machine, with a plan for what it needs`.

### Task 3: The scripts that install, start and probe an instance

**Files:**
- Modify: `src/main/remote-host.ts`, which gains three script builders.
- Create: `scripts/check-instance-scripts.mts`, registered as `check:instance-scripts`. It runs the scripts with `sh` against a temporary home, as `check-remote-scripts.mts` does.

**Interfaces:**
- `instanceStatusScript(): string` prints `INSTANCE_HASH=<contents of .bifrost/instance/build-hash>` and, when the API answers, `INSTANCE_PORT=<port>`. It probes with `node -e` and `fetch`, with a 2 s timeout.
- `installInstanceScript(hash: string): string`
  - Run after `instance.new` is unpacked: `npm install --omit=dev --no-audit --no-fund --loglevel=error` in it, then write `build-hash`.
  - Then `rm -rf .bifrost/instance && mv .bifrost/instance.new .bifrost/instance`.
  - Any failure exits non-zero and leaves `.bifrost/instance` as it was.
- `startInstanceScript(): string`
  - It kills the tmux session `=instance` on `tmux -L bifrost -f .bifrost/tmux.conf`, if there is one.
  - It starts a new one running `cd "$HOME/.bifrost/instance" && while :; do node headless.js; sleep 2; done`.
  - It waits up to 30 s for the probe to answer, then prints `INSTANCE_PORT=<port>`.
- All three use `parseScriptOutput`'s `KEY=value` lines, like `prepareScript`.

- [ ] **Step 1: Write the failing check.**
  - It builds through `pack(repoRoot)` and unpacks into `$HOME/.bifrost/instance.new`.
  - It uses a stub `npm` first on `PATH` that links the checkout's `node_modules` into the current directory. That stands in for the install, with no network.
  - It puts a stub `claude` on `PATH`, and sets `TMUX_TMPDIR` and `TMPDIR` to the temporary root.

```ts
// 'an installed instance starts in tmux and answers'
// installInstanceScript(hash) exits 0; status then says INSTANCE_HASH=hash and no port;
// startInstanceScript() prints INSTANCE_PORT, and POST /list-tasks there answers 200.

// 'starting it again restarts it and leaves the other sessions running'
// note the console session's tmux pid; startInstanceScript() again prints INSTANCE_PORT that answers;
// the console session still runs and the first instance process has exited (its pid is gone).

// 'a failed install leaves the running instance as it was'
// with a stub npm that exits 1, installInstanceScript('other') exits non-zero, build-hash is still hash,
// and the instance still answers.
```

- [ ] **Step 2:** Run it. Expected: it fails because the builders don't exist.
- [ ] **Step 3:** Implement the three builders.
- [ ] **Step 4:** Run it. Expected: `all checks passed`, with no tmux server or `node` process left behind. The check kills its server in a `finally`.
- [ ] **Step 5: Verify and commit.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - Run `test-discipline-pass`.
  - Commit `feat: scripts that install, start and probe an instance on another machine`.

### Task 4: `RemoteHost.ensureInstance()`

**Files:** Modify `src/main/remote-host.ts` and `CLAUDE.md` (one paragraph in "Tasks on other machines").

**Interfaces:**
- `ensureInstance(): Promise<number>`
  - It runs `connectReady()`, `pack(process.cwd())`, then the status script and `plan()`.
  - `install`: `sendTar(dir, 'rm -rf .bifrost/instance.new && mkdir -p .bifrost/instance.new && tar -xzf - -C .bifrost/instance.new')`, then the install script, then the start script.
  - `start`: the start script.
  - Then a local port from a throwaway `net` listener on `127.0.0.1:0`, and `ssh -S <control> -O forward -L <local>:127.0.0.1:<INSTANCE_PORT> <host>`.
  - It resolves to the local port.
  - A forward made before is reused while the remote port is the same. Otherwise it is cancelled with `-O cancel` and made again.
  - Calls made while one is in flight join it.
- Nothing calls it in this plan. 3c-2 passes `() => host.ensureInstance()` to `registerPeer`.

- [ ] **Step 1:** Implement it. No check can reach `ssh` here, so Tasks 2 and 3 pin its parts, and 3c-2 runs it against perf by hand, with the user's go-ahead.
- [ ] **Step 2: Verify.**
  - Lint passes, tsc still reports 18 errors, and every `check:*` passes.
  - `grep -n "ensureInstance(" src/main/*.ts` shows only its definition.
- [ ] **Step 3: Docs and commit.**
  - Run `comment-discipline-pass`.
  - Commit `feat: the IDE can bring up an instance on a configured machine and tunnel to it`.
