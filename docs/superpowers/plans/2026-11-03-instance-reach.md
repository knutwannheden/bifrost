# Instance Reach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Perf's instance links back to the IDE's, so perf's tools see the IDE's tasks too. `create_task` takes `"local"`, `"ide"` or a machine name, and means the same thing whichever machine asks.

**Architecture:** This is plan 4a of step 4. 4b, moving a task from a machine back to this one, follows.
- **The link back.** Each time the IDE connects to a machine's instance, it posts `POST /link-back { name: 'ide', port }` to it. `port` is the IDE's API as forwarded to that machine, which `link()` already sets up with `-R`. The instance registers the IDE as its peer `ide` and connects.
- **Listing.** `/list-tasks` and `/find-task` already include peer tasks. They now leave out an unreachable peer's, since "with the laptop offline, they list perf's own tasks" (spec). A peer's task keeps the machine its record names, and only one without a machine is tagged with the peer's name. So on perf, the IDE's tasks on `recipes` show as `recipes`, not `ide`. Routing goes by `peerOf(taskId)`, never by that label.
- **Creating.** `/create-task` reads `machine`:
  - Omitted, `"local"` or the instance's own `BIFROST_MACHINE` mean here.
  - On the IDE, which has no `BIFROST_MACHINE`, `"ide"` also means here.
  - On an instance elsewhere, every other value goes to its peer `ide`, which knows the configured machines. `"ide"` itself is sent there as omitted.

```
perf session: create_task(machine: "ide") ─▶ perf /create-task ─▶ postToPeer('ide', '/create-task', …) ─▶ IDE creates it here
perf session: list_tasks                    ─▶ perf /list-tasks: perf's own + the IDE's (while linked), each with its machine
```

**Tech Stack:** TypeScript, the peer link (`peers.ts`), the MCP server (`src/claude-plugin/mcp/server.mjs`), and check scripts that run two headless instances.

**Spec:** `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md`. The relevant sections are "The links between instances" and "`create_task` across machines".

## Global Constraints

- "`-R` carries perf's calls to the IDE's instance … While connected, each instance can query the other. Perf's MCP tools then also list the IDE's tasks, each marked with its machine. With the laptop offline, they list perf's own tasks." (spec)
- `machine` values (spec):
  - "Omitted, or `"local"`: the caller's machine."
  - "`"ide"`: the machine the IDE runs on, only while it is connected."
  - "A configured machine name: that machine."
- "The tool's description is built for the machine the MCP server runs on, so it tells Claude what each word means from where it runs." (spec)
- Any change under `src/claude-plugin/` bumps `version` in its `plugin.json`, from 1.26.0 to 1.27.0. The user is told to accept the integration update, and a remote machine gets the new plugin at its next connect (`syncPlugin`).
- Type-check gate: 18 errors before this plan, and no task adds one. `npm run lint` passes. Every `check:*` passes.
- Out of scope: moving a task between instances in either direction (4b).

## Review Focus

1. **Echoes.** Each instance lists only its own tasks plus its peers' own, never a peer's peers, so the IDE never sees its own tasks come back through perf. LIST_TASKS over `/call` answers `getTasks()`, which this keeps true.
2. **A changing port.** The forwarded port changes whenever the IDE reconnects. Each connect posts `/link-back` again, and `registerPeer` swaps the `connect` of the peer already registered.
3. **The laptop away.** `create_task(machine: "ide")` on perf fails with an error naming `ide`, and `list_tasks` lists perf's own tasks.
4. **A label that is not a peer.** `remote-host.ts` decides a machine holds instance tasks from `peerTasks().some((t) => t.machine === name)`. Keeping a record's own machine leaves that true, since perf's tasks name `perf` or nothing.
5. **Machine names on perf.** perf's config has no machines. A name other than its own, such as `recipes`, goes to the IDE, and the IDE's answer, refusal included, comes back unchanged.

---

### Task 1: The link back, and listing what is reachable

**Files:**
- Modify: `src/main/remote-host.ts` (`RemoteInfo.apiPort`, the forwarded port `link()` gets)
- Modify: `src/main/instance-link.ts` (the connect posts `/link-back` after `/preferences`)
- Modify: `src/main/peers.ts` (`peerTasks`, a forwarded call's answer and `relay` tag only a task without a machine)
- Modify: `src/main/bifrost-api.ts` (`POST /link-back`, and unreachable peer tasks left out of `/list-tasks` and `/find-task`)
- Create: `scripts/check-instance-reach.mts`, registered as `check:instance-reach`. It runs two headless instances, A as the IDE with no `BIFROST_MACHINE`, and B with `BIFROST_MACHINE=perf`, each in its own home, tmp and tmux server.

- [ ] **Step 1: Write the failing check.** A holds two saved tasks, `ta` with no machine and `tr` on machine `recipes`.

```ts
// 'an instance linked back to the IDE lists the IDE's tasks with their machine'
// POST B /link-back { name: 'ide', port: <A's port> }; within 5 s B's /list-tasks {status:'all'} has ta
// with machine 'ide' and tr with machine 'recipes', and A's /list-tasks does not have ta twice.

// (after Task 2's check) 'with the IDE away, an instance lists its own tasks'
// SIGTERM A; within 5 s B's /list-tasks {status:'all'} no longer has ta.
```

- [ ] **Step 2:** Run it. Expected: 404 on `/link-back`.
- [ ] **Step 3:** Implement it. `/link-back` calls `registerPeer(name, async () => port)`, then `connectPeer(name)` in the background, logging a failure.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Lint passes, tsc still reports 18 errors, every `check:*` passes, and `test-discipline-pass` has run. Commit `feat: a machine's instance links back to the IDE and lists its tasks`.

### Task 2: `create_task` across instances

**Files:** `src/main/bifrost-api.ts`, `scripts/check-instance-reach.mts`.

- [ ] **Step 1: Write the failing check** in `check-instance-reach.mts`:

```ts
// 'create_task on an instance goes to the IDE for "ide", and stays for "local"'
// POST B /create-task { machine: 'ide', repoPath: '/no/such/repo', prompt: 'x' } answers an error starting 'ide:';
// POST B /create-task { machine: 'local', repoPath: '/no/such/repo', prompt: 'x' } answers 400 without it.
```

- [ ] **Step 2:** Run it. Expected: the first answers B's own 400.
- [ ] **Step 3:** Implement `/create-task`'s reading of `machine` as the Architecture section says. Forwarding uses `postToPeer('ide', '/create-task', …)`. A failure answers 502 with the message prefixed `ide: `.
- [ ] **Step 4:** Run it. Expected: pass.
- [ ] **Step 5:** Lint passes, tsc still reports 18 errors, every `check:*` passes, and `test-discipline-pass` has run. Commit `feat: create_task reaches the IDE and its machines from a machine's instance`.

### Task 3: The tool description, from where it runs

**Files:** `src/claude-plugin/mcp/server.mjs`, `src/claude-plugin/.claude-plugin/plugin.json`, `CLAUDE.md`.

- [ ] **Step 1:** `create_task`'s `machine` description is built from `MACHINE`.
  - With `MACHINE` set, it says: omitted or `"local"` is this machine (named); `"ide"` is the machine Bifrost's window runs on, while it is connected; another name is that machine.
  - Without it, it says: omitted is this machine, and a name from Bifrost's settings is that machine.
  - Both keep today's notes on `worktree` and SendMessage.
- [ ] **Step 2:** Bump `plugin.json` to 1.27.0.
- [ ] **Step 3:** In CLAUDE.md's "Tasks on other machines", add one paragraph on the link back and on `machine` values. Run `comment-discipline-pass`.
- [ ] **Step 4:** Lint passes and every `check:*` passes. Commit `feat: create_task describes its machine values from where it runs`.
- [ ] **Step 5: Final review, then by hand after merge and restart.**
  - A perf session's `list_tasks` shows the laptop's tasks marked `ide`.
  - `create_task(machine: "ide")` from perf's console creates a task here.
  - The user accepts the integration update for the new plugin version.
