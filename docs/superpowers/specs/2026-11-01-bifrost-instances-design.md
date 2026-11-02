# A Bifrost instance on every machine

## Problem

Bifrost runs on the user's laptop, and the laptop owns every task. A task on another machine, such as the devpod `perf`, runs in tmux there. The laptop drives it with shell scripts over its own SSH connection (`remote-host.ts`, `task-transfer.ts`, `remote-sync.ts`).

Sometimes the laptop is offline, and the user reaches perf's tasks through Claude Remote Control. Those tasks then lose Bifrost entirely. Their MCP tools and hooks call the laptop's API through a reverse forward that exists only while the laptop's SSH connection is up. So they cannot list each other, create tasks or receive Bifrost's notices.

Even with the laptop connected, perf tasks are second-class:

- **Missing features:** the services that read files from local disk skip them. That covers token usage, the activity log and the curator.
- **Shell scripts:** every operation on a remote task is a hand-written script.
- **The terminal:** it reaches the tab through tmux redrawing its screen, so the tab's own scrollback is lossy. Of 3000 lines printed at once, 29 reached it.
- **Restarts:** a restart of the laptop's Bifrost ends every local session.

## Intent

Each machine runs a Bifrost instance that owns the tasks running there. The IDE on the laptop is one of these instances, and it keeps showing every machine's tasks in one window, as it does today. Perf stays fully usable through Remote Control while the laptop is offline.

### Goals

- With the laptop offline, perf's tasks can list, create and message each other, and receive Bifrost's notices. A task created then can itself be reached through Remote Control.
- One window on the laptop shows every machine's tasks, with the features local tasks have.
- Restarting an instance leaves the sessions it holds running. This applies to the laptop's instance too.
- The IDE's instance and a headless instance run the same code.

### Non-goals

- Authentication on the HTTP APIs.
- Copying task records between instances.
- Starting perf's instance when perf boots. After perf restarts, nothing runs until the IDE connects. The user restarts a stopped devpod from its web UI. A later option is to have the login shell on perf start the instance.
- Several instances on one machine.
- Instances finding each other. The machines configured in the IDE are the only links.

### Anti-goals

- Local tabs getting worse than today in scrollback, latency, links or colour.
- An update to perf's instance ending perf's sessions.
- An instance listening on anything but loopback. Its API has no authentication.

## Constraints

- **perf:** a Linux devpod on Coder, reached by `ssh perf.coder`, which `~/.ssh/config` routes through `coder ssh --stdio`. It has Node 24.22 at `/usr/bin/node`, tmux 3.4, `setsid` and `nohup`. PID 1 is systemd, but there is no per-user systemd. It can stop on its own. Connecting through `coder ssh` starts it again, and an open connection may keep it from stopping.
- **The laptop:** macOS. Bifrost runs in development mode from a checkout and restarts many times a day, often through `scripts/restart-bifrost.sh` from inside a task.
- **Electron 43:**
  - `better-sqlite3` is rebuilt for Electron's ABI and does not load under plain Node.
  - `node-pty` and `@parcel/watcher` use N-API and ship Linux prebuilds.
- **SSH:** the laptop already keeps one OpenSSH master connection per machine, under `~/.bifrost/ssh/`. Tabs and commands share it.

## Design

Choices marked *(my call)* are the designer's defaults, not the user's decisions.

### Each task has one owner

A task's record lives in the database of the instance on the machine where it runs, and nowhere else. Task ids are UUIDs, so ids from different instances never collide. The laptop's database keeps the laptop's tasks. The existing perf tasks move into perf's instance once.

### Sessions live in tmux and are attached in control mode

Every Claude session, on every machine, runs in a tmux session on Bifrost's own tmux server. That is how remote tasks already run. Moving local sessions there too lets them outlive a restart of their instance, which reattaches when it comes back up.

*(my call)* Instances attach in tmux control mode, not as a client that draws the screen:
- A control client receives each pane's raw output, so the tab's xterm.js gets Claude's own bytes. Scrollback, links and colour then behave as they do in local tabs today.
- A control client draws nothing, so the instance and the IDE can both attach to one session without their output being drawn twice.

To open a perf task's terminal, the IDE asks perf's instance which tmux session the task runs in. It then attaches in control mode over its SSH connection.

A session id keeps a single attachment per instance. One stream per tab is the invariant that the doubled-input bug of 2026-11-01 broke.

### The headless instance

- **Build:** a plain Node entry point, built as a second Vite main target.
- **Separating Electron:** services reach the window only through an event sink. Today nine modules take a `BrowserWindow` only to call `webContents.send` on it.
- **`ipc-handlers.ts`:** split into task logic, which `bifrost-api`, curator, disk-reclaim and prompt-sender import, and the IPC registration.
- **Behaviour that needs a new home:**
  - `prompt-sender` reads a half-typed prompt from the tab's xterm. The headless xterm in `session-mirror` can answer that instead.
  - Today a session starts when its tab is first opened. A headless instance starts its sessions on its own. *(my call)* When it comes up, it reattaches to every tmux session still running. For a task whose tmux session is gone, such as after perf restarts, it starts the session only if the task is in use. A task is in use when it was mid-turn or its turn state changed in the last hour, which is the rule `restart-bifrost.sh` uses. The rest start when a tab opens them or `wake_task` asks.
- **Its own console:** the `bifrost` session on that machine, reachable through Remote Control. *(my call)*
- **Session settings:** permission mode, `remoteControlAtStartup` and agent teams come from the instance's copy of the config (below). Today the laptop decides them for remote sessions.
- **Approvals:** in managed-permissions mode, an approval request falls back to Claude's own prompt at once when no window is connected. Today it waits 2 minutes first (`permission-manager.ts:203`). *(my call)*
- **Notices:** Bifrost's notices to sessions (`relayMessage`) are sent on the instance's own machine.

### Starting and updating perf's instance

- **Connecting:** the IDE connects to perf the first time something needs it, such as opening a perf task or creating a task there. It then stays connected until the IDE quits. A stopped perf stays stopped until the user needs it.
- **After a drop:** *(my call)* when the connection drops, such as while the laptop sleeps, the IDE reconnects at the next need, as it first connected. Reconnecting at once would start a perf that stopped in the meantime.
- **Starting:** on connect, the IDE starts perf's instance if `~/.bifrost/api-port` there does not answer. It runs detached (`setsid nohup …`) and keeps running when the connection drops.
- **Updating:** the IDE ships the instance's build to perf and installs its Linux native modules there. It restarts the instance when the build changes.

### The links between instances

All traffic between instances travels over the IDE's SSH master connection, with both ends on loopback:
- `-L` carries the IDE's calls to perf's instance.
- `-R` carries perf's calls to the IDE's instance, as today.

MCP servers stay one stdio process per session and do not change. They read `~/.bifrost/api-port`, which names the instance on their own machine.

While connected, each instance can query the other. Perf's MCP tools then also list the IDE's tasks, each marked with its machine. With the laptop offline, they list perf's own tasks.

### The IDE's window

- **Task list:** the IDE's own tasks plus what each connected instance reports. *(my call)* For an instance not connected, the window shows its last answer, greyed out. That copy is kept on disk, so it survives a restart of the IDE. It is only for display. Acting on one of its tasks connects first and then goes to the owner. When the connection fails, the action fails with it.
- **Routing:** an IPC call for a task on another machine goes to that machine's instance over the tunnel, and that instance's events reach the renderer as local events do. *(my call)* This is one routing mechanism, not a change to each of the 78 handlers.
- **Catching up:** on each connect, the IDE fetches a snapshot and then subscribes. Events from while it was disconnected are not replayed. *(my call)*

### Config

*(my call)* The config splits in two:
- **Repos belong to each instance.** Perf's repo list is its own clones, and `add_repo` from perf adds to it, offline or not. Each task an instance reports carries its repo's name and GitHub slug. The IDE can then show it without knowing the other instance's repo ids.
- **Preferences come from the IDE.** On connect, the IDE copies its prompts, permission mode, agent teams, and the Claude settings Bifrost reads, such as `remoteControlAtStartup`. Perf keeps the last copy for when the laptop is away.

### `create_task` across machines

`machine` values:
- Omitted, or `"local"`: the caller's machine.
- `"ide"`: the machine the IDE runs on, only while it is connected.
- A configured machine name: that machine.

The tool's description is built for the machine the MCP server runs on, so it tells Claude what each word means from where it runs.

### Transfer

Moving a task hands its record from one owner to the other. The target imports it, keyed by task id, so a retry cannot create a duplicate. The source deletes its copy only after the target confirms. The worktree and transcript travel as they do today: the commits as a bundle, staged and unstaged changes as patches, and the transcript with paths rewritten.

## Order of work

*(my call)* Each step pays off on its own:

1. **Sessions in tmux, attached in control mode,** on the laptop and on perf. Restarts stop ending sessions, and every tab gets raw output.
2. **The event sink and the split of `ipc-handlers.ts`.** This changes no behaviour.
3. **The headless instance on perf, together with the IDE combining instances.** Perf's instance owns perf's tasks, and the existing ones migrate. Landed apart, perf's tasks would vanish from the window in between. Perf's console comes with this step, since with the laptop offline it is the only way to wake a task that isn't running.
4. **Transfer and `create_task` across instances.**

## Left to the builder

- The tmux control-mode client: parsing its output, sending input, resizing, and replaying history on attach.
- `node:sqlite` or `better-sqlite3` built for Node in the headless instance.
- Restarting perf's instance after a crash: a respawn loop, or a window in Bifrost's tmux server.
- The wire format for routed calls and events over the tunnel.
- How the build reaches perf and how its native modules get installed.
- What becomes of the shell scripts in `remote-host.ts`, `task-transfer.ts` and `remote-sync.ts`.
- Dev terminals for tasks on another machine. Today they have none.
