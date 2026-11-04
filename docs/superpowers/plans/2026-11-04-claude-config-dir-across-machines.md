# Claude Config Dir Across Machines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restarting Bifrost with another `CLAUDE_CONFIG_DIR` switches the Claude account for every task it starts afterwards, on this Mac and on the other machines.

**What changes, in plain terms.** Today `~/.claude-work` holds its own login and links everything else into `~/.claude`, transcripts included.
- **Before:** after `CLAUDE_CONFIG_DIR=~/.claude-work npm start`:
  - A new local task still runs under `~/.claude`, because its tmux server kept the old environment.
  - A task on perf runs under perf's `~/.claude` and its account.
- **After:**
  - Every session Bifrost starts runs with `CLAUDE_CONFIG_DIR=<its home>/.claude-work`. That covers this Mac, perf's instance, and scripts on a remote machine.
  - Setup sync gives perf a `~/.claude-work` whose links point into perf's `~/.claude`, as here.
  - Restarting without the variable sets it back to unset everywhere.

```
here:  ~/.claude-work/projects -> /Users/knut/.claude/projects     (own .claude.json, own login)
perf:  ~/.claude-work/projects -> ../.claude/projects              (made by sync; login once with /login)
run.sh on perf:  export CLAUDE_CONFIG_DIR='/home/coder/.claude-work'
```

**Architecture:**
- **Where the config dir comes from.** `claude-paths.ts` derives each machine's config dir from Bifrost's own `CLAUDE_CONFIG_DIR`, at the same path relative to home.
- **Sessions.** `sessionFiles` writes the result into every `run.sh`, or unsets it.
- **Remote scripts.** The prepare, session-setup and transcript-unpack scripts export it before Claude, python or the login check reads it.
- **Perf's instance.** It gets the home-relative path with the preferences on connect, keeps it in its config, and applies it to its own process.
- **Setup sync.** It reads the parts through the active dir. It recreates that dir's top-level links into `~/.claude` as relative links on the machine.

**Tech Stack:** TypeScript and POSIX sh scripts. The checks run the scripts against a local home.

**Spec:** none. The design was agreed in conversation on 2026-11-04, and the Global Constraints below record its decisions. `docs/superpowers/specs/2026-11-01-bifrost-instances-design.md` ("Preferences come from the IDE") covers how preferences reach an instance.

## Global Constraints

- A session runs with the config dir Bifrost runs with, at the same path relative to its home. When Bifrost runs without `CLAUDE_CONFIG_DIR`, `run.sh` unsets it.
- On another machine the variable is set per session and per script, never in the machine's shell profile.
- Logins never travel. Sync never writes `.claude.json` or `.credentials.json` under any config dir. The user logs in once per account per machine.
- `~/.claude` stays the real store. Content syncs to the link targets (`.claude/skills` and so on), and transcripts stay shared through `projects`.
- Link recreation applies only when the active dir is not `~/.claude`, and only to its top-level links into `~/.claude`. With the default dir, sync behaves exactly as today.
- Out of scope:
  - removing a link that disappeared here;
  - a config dir outside home on another machine, where sessions there fall back to Claude's default and Bifrost logs it.
- Gates: `npm run lint` passes, tsc reports 18 errors as on `main` (`2d1fbcd`), and every `check:*` passes.

## Review Focus

1. **Switching back.** Bifrost restarted without the variable must give `unset CLAUDE_CONFIG_DIR`, so a tmux server started under the old value does not leak it (Task 1).
2. **A real entry where a link would go there**, such as a `~/.claude-work/history.jsonl` a manual `claude` run left on perf. It stays untouched, and sync logs it (Task 3).
3. **An instance restarted while the IDE is away** keeps the dir it last got (Task 2).
4. **A config dir outside home.** Local sessions use it as it is. Sessions on another machine fall back (Task 1).
5. **No login yet in that dir on the machine.** Connect reports it, naming the dir, because the login check runs under the exported variable (Task 1).

---

### Task 1: Sessions and remote scripts run with Bifrost's config dir

**Files:**
- Modify: `src/main/claude-paths.ts`, `src/main/tmux-session.ts` (`sessionFiles`), `src/main/remote-host.ts` (`prepareScript`, `sessionSetupScript`, the not-logged-in message in `connectReady`), `src/main/task-transfer.ts` (`unpackScript`)
- Test: `scripts/check-transcript-dir.mts`, `scripts/check-remote-scripts.mts`, `scripts/check-task-transfer.mts`

**Interfaces:**
- Produces, in `claude-paths.ts`:
  - `claudeConfigRelative(): string | null`: Bifrost's `CLAUDE_CONFIG_DIR` relative to `os.homedir()`. It is null when the variable is unset or lies outside home.
  - `claudeConfigDirAt(home: string): string | undefined`: the dir for a session on the machine whose home is `home`. That's `home` plus the relative path. When the variable lies outside home, it's the variable as it is if `home === os.homedir()`, and undefined otherwise, with one warning logged. When the variable is unset, it's undefined.
  - `configDirScript(): string`: one shell line for scripts on another machine, either `export CLAUDE_CONFIG_DIR="$HOME"/'<relative>'` or `unset CLAUDE_CONFIG_DIR`.

- [ ] **Step 1: Write the failing checks.** The checks set `process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude-work')` and restore it afterwards.

```ts
// check-transcript-dir: 'a config dir is the same path relative to each machine's home'
// claudeConfigDirAt('/home/ann') === '/home/ann/.claude-work'; with the variable at '/opt/claude-x':
// claudeConfigDirAt(os.homedir()) === '/opt/claude-x' and claudeConfigDirAt('/home/ann') === undefined;
// unset: claudeConfigDirAt(os.homedir()) === undefined.

// check-remote-scripts, on the first attach (the remote home has a .claude-work/.claude.json):
// 'a session runs with the config dir Bifrost runs with, and is trusted in that dir's config'
// the stub claude records $CLAUDE_CONFIG_DIR === `${home}/.claude-work`, and trust lands in
// `${home}/.claude-work/.claude.json` while `${home}/.claude.json` is unchanged.
// 'without one, a session runs with it unset, whatever its environment held'
// variable unset here, runRemote with CLAUDE_CONFIG_DIR=/stale in its env: the stub records ''.
// 'connecting marks onboarding and checks the login in that config dir'
// prepareScript under the variable seeds hasCompletedOnboarding into `${home3}/.claude-work/.claude.json`.

// check-task-transfer: 'a moved transcript is filed under the config dir sessions there use'
// with the variable set, unpackScript files it under `${there}/.claude-work/projects/<dir>/<id>.jsonl`.
```

- [ ] **Step 2:** Run `npm run -s check:transcript-dir`, `check:remote-scripts` and `check:task-transfer`. Expected: the new cases fail, and the stub sees the default dir.
- [ ] **Step 3:** Implement the three helpers.
  - `sessionFiles` puts `export CLAUDE_CONFIG_DIR=<claudeConfigDirAt(spec.home)>` or `unset CLAUDE_CONFIG_DIR` before the other exports.
  - `prepareScript`, `sessionSetupScript` and `unpackScript` start with `configDirScript()`, right after `set -e`.
  - `connectReady`'s not-logged-in message names the dir when `claudeConfigRelative()` is set: `run CLAUDE_CONFIG_DIR=~/<relative> claude there once and /login`.
- [ ] **Step 4:** Run the three checks. Expected: they pass.
- [ ] **Step 5:** Lint passes, tsc reports 18 errors, every `check:*` passes, and `test-discipline-pass` has run. Commit `fix: sessions and remote scripts run with the config dir Bifrost runs with`.

### Task 2: A machine's instance keeps the IDE's config dir

**Files:**
- Modify: `src/shared/types.ts` (`BifrostConfig.claudeConfigDir?: string | null`, the home-relative dir the IDE last sent), `src/main/claude-paths.ts`, `src/main/instance-link.ts` (`sendPreferences`), `src/main/bifrost-api.ts` (`/preferences`), `src/main/headless.ts`
- Test: `scripts/check-instance-reach.mts`

**Interfaces:**
- Consumes `claudeConfigRelative()` from Task 1.
- Produces `applyClaudeConfigDir(relative: string | null | undefined): void` in `claude-paths.ts`. It sets `process.env.CLAUDE_CONFIG_DIR` to `os.homedir()` plus `relative`, or deletes it when `relative` is null. Undefined leaves the variable as it is.

- [ ] **Step 1: Write the failing check** in `check-instance-reach.mts`, against B as the machine:

```ts
// 'a machine's instance runs its sessions with the config dir the IDE sent, and keeps it across a restart'
// POST B /preferences { claudeConfigDir: '.claude-work' }; B creates a task with machine 'local';
// its run.sh under b.home/.bifrost/sessions/<id>/ has `export CLAUDE_CONFIG_DIR='${b.home}/.claude-work'`.
// SIGTERM B, start it again on the same home, create another task: its run.sh has the same line.
// POST B /preferences { claudeConfigDir: null }; a third task's run.sh has `unset CLAUDE_CONFIG_DIR`.
```

- [ ] **Step 2:** Run `npm run -s check:instance-reach`. Expected: the new case fails, because run.sh unsets the variable.
- [ ] **Step 3:** Implement it.
  - `sendPreferences` adds `claudeConfigDir: claudeConfigRelative()`.
  - `/preferences` adds `claudeConfigDir` to its copied keys, then calls `applyClaudeConfigDir(body.claudeConfigDir)` when the key is present.
  - `headless.ts` calls `applyClaudeConfigDir(loadConfig().claudeConfigDir)` before the instance starts. The IDE never reads this field, so its own environment stays in charge there.
- [ ] **Step 4:** Run the check. Expected: it passes.
- [ ] **Step 5:** Lint passes, tsc reports 18 errors, every `check:*` passes, and `test-discipline-pass` has run. Commit `feat: a machine's instance runs its sessions with the IDE's config dir`.

### Task 3: Setup sync follows the active config dir

**Files:**
- Modify: `src/main/remote-sync.ts` (`SyncOptions.configDir: string`, the parts, the links, `PROTECTED`), and the caller in `src/main/remote-host.ts` (`syncSetup` passes `configDir: claudeConfigDir()`)
- Test: `scripts/check-remote-sync.mts`

**Interfaces:**
- Consumes `claudeConfigDir()` from `claude-paths.ts`, which is already on main.
- Produces, internal to `remote-sync.ts`:
  - `configPart(o: SyncOptions, name: string): { from: string; path: string }` says where a top-level entry of the config dir is read here and written there. In a config dir other than `~/.claude`, an entry that links into `~/.claude` is read and written as that target, for example `.claude/skills`. Any other entry is itself, for example `.claude-work/settings.json`.
  - `configLinks(o: SyncOptions): Array<{ path: string; target: string; dir: boolean }>` lists those links as home-relative paths. It's empty for `~/.claude`.

- [ ] **Step 1: Write the failing check** in `check-remote-sync.mts`. `here` gets `.claude-work` containing:
  - `skills`, an absolute link to `${here}/.claude/skills`;
  - `settings.json`, a relative link `../.claude/settings.json`;
  - `projects`, a link to `${here}/.claude/projects`;
  - `history.jsonl`, a link to `${here}/.claude/history.jsonl`;
  - its own `.claude.json` and `.credentials.json`.

  `there` already holds a real `.claude-work/history.jsonl` containing `mine`. The check syncs with `configDir: ${here}/.claude-work`.

```ts
// 'another config dir arrives as links into ~/.claude there, and its own files stay here'
// readlinkSync(there/.claude-work/skills) === '../.claude/skills' and there/.claude/skills holds the skill;
// readlinkSync(there/.claude-work/settings.json) === '../.claude/settings.json' and there/.claude/settings.json exists;
// readlinkSync(there/.claude-work/projects) === '../.claude/projects' and there/.claude/projects is a directory;
// there/.claude-work/.claude.json and .credentials.json do not exist;
// there/.claude-work/history.jsonl is still a regular file reading 'mine'.
```

- [ ] **Step 2:** Run `npm run -s check:remote-sync`. Expected: it fails, because `.claude-work` is not created there.
- [ ] **Step 3:** Implement it.
  - `units()` reads `CLAUDE.md`, `skills`, `agents`, `commands`, `settings.json` and the two plugin files through `configPart`. Their unit paths come from it, which keeps every path as it is today with the default dir.
  - The rules import goes into `configPart(o, 'CLAUDE.md').path`.
  - The sync script recreates each `configLinks` entry:
    - `mkdir -p` the link's directory.
    - Create the target when missing, with `mkdir -p` for a directory or an empty file otherwise.
    - When the path is absent or already a link, `ln -sfn` it to the relative target, which is `path.posix.relative` from the link's directory. Otherwise print `KEPT=<path>`, which `syncMachine` logs as a warning.
  - `PROTECTED` gains `<relative>/.claude.json` and `<relative>/.credentials.json` for the active dir.
- [ ] **Step 4:** Run the check. Expected: it passes, along with the existing default-dir cases.
- [ ] **Step 5:** Lint passes, tsc reports 18 errors, every `check:*` passes, and `test-discipline-pass` has run. Commit `feat: setup sync recreates the active config dir's links into ~/.claude on the machine`.

### Task 4: Document it

**Files:** `CLAUDE.md` ("Tasks on other machines").

- [ ] **Step 1:** Add one paragraph covering three points:
  - Sessions everywhere run with Bifrost's `CLAUDE_CONFIG_DIR`, at the same path relative to home, and the instance keeps it from the preferences.
  - Sync recreates that dir's links into `~/.claude` on the machine.
  - The login is per machine.

  Then run `comment-discipline-pass` over the whole branch.
- [ ] **Step 2:** Commit `docs: a config dir follows Bifrost to every machine`.
- [ ] **Step 3: Final review, then by hand after merge:**
  - On perf, run `CLAUDE_CONFIG_DIR=~/.claude-work claude`, then `/login` with the work account.
  - Start Bifrost here with `CLAUDE_CONFIG_DIR=~/.claude-work`, then open perf's console tab.
  - A new local task and a new perf task both show the work account.
  - Restart without the variable. New tasks show the default account again.
