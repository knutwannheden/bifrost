# headroom

Advisory claims on shared resources, so parallel agent sessions on one machine do not run a benchmark on top of a test suite. One SQLite file, a CLI, and a hook that puts the board in front of every session.

```
headroom run cpu --exclusive --why "JMH on the parser; another heavy process invalidates the run" -- ./gradlew jmh
headroom acquire cpu --exclusive --ttl 10m --why "JMH on the parser; another heavy process invalidates the run"
headroom acquire cpu --shared --why "full suite, ~6 min, just slower if you join"
headroom wait <id>
headroom release <id>
headroom notice cpu --why "generator power, prefer targeted tests" --ttl 2h
headroom seize cpu --why "release timing, cannot wait"
headroom status
```

`shared` claims hold together, `exclusive` holds alone, a `notice` stops new grants without holding anything. The queue is walked by priority then age, and a waiting exclusive claim holds back the shared claims behind it. Nothing is enforced: a session that was told can still proceed, and is expected to say so.

There is no server. Each command opens the SQLite file, settles the queue under a write lock, and exits. Cleanup needs no sweeper either: a claim records its session's process id and is dropped the next time anyone looks after that process is gone; while `run` or `hold` holds it, it is tied to that wrapper instead, so killing the wrapper frees the resource at once; and a claim nobody renews lapses at its ttl whether held or waiting.

Requires Node 24 (built-in `node:sqlite`, runs `.ts` directly).

## Install

```
cd tools/headroom && npm install
ln -s "$PWD/src/cli.ts" ~/.local/bin/headroom     # or anywhere on PATH
ln -s "$PWD/skill" ~/.claude/skills/headroom
```

`run` wraps a command: it waits for the claim, renews it while the command runs, releases on exit, and acts on a yield request. `hold <id> -- <cmd>` is the middle part alone, for a claim held across several commands; `run` is `acquire --wait`, `hold` and `release`. On a yield, both write a marker file the command sees as `$HEADROOM_YIELD` and stop the command's process group when `--grace` runs out (`0` at once, `3m` after a loop has had time to finish its rep, `never` only warns). Exit codes: 0 granted or done, 1 queued, refused or lapsed, 2 wait timed out, 3 stopped for a yield, else the command's own; `acquire -q` prints only the id for `$(...)`.

The hook shows a session the board at session start, whenever something it could act on changed since it last looked (a notice, an exclusive claim, an offer, a waiter, a yield request), and on every prompt while the session holds or waits — not on every prompt regardless. Other sessions' running shared claims block nobody and reach a session without a claim only as a count, so their coming and going does not bring the board back.

An exclusive claim is granted only onto a quiet machine. At the moment of grant, headroom samples CPU time per process over three seconds (two `ps` snapshots, so no lagging average) and refuses with exit 4 and the pids when processes outside every claim — and outside the asker's own session — each busy at least half a core, together burn more than `HEADROOM_QUIET_CPU` percent of a core (default 150). Processes under that floor are the desktop's idle hum, not contention, however many there are. `--force` takes the claim anyway; shared claims are never refused for load. `status` prints the same sample. Where `ps` cannot run, the grant goes through with a note saying it was unchecked.

## Hook

In `~/.claude/settings.json`, so every session sees the board when it is non-empty:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "headroom hook" }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "headroom hook" }] }]
  }
}
```

The hook prints nothing when nothing is claimed. Otherwise `systemMessage` carries a one-line banner for the terminal and `additionalContext` the full board for the model, including a yield request against the session's own claim.

## The rule for `~/.claude/CLAUDE.md`

```
## Shared machine
Before anything that pins the CPU for minutes — benchmarks, profiling, full builds, long test suites —
run `headroom acquire cpu` (`--exclusive` when another heavy process would corrupt your numbers, `--shared`
when it would only slow you down), and `headroom release` when done. If the board says the resource is held,
wait with `headroom wait`, or message the holder by the name shown and agree on an order. If asked to yield,
stop and release. The `headroom` skill has the details.
```

## Environment

| Variable | Meaning |
|---|---|
| `HEADROOM_DB` | Board file (default `~/.headroom/board.db`) |
| `HEADROOM_AS`, `BIFROST_SESSION_NAME` | Default holder name — the name other sessions message you by |
| `CLAUDE_CODE_SESSION_ID` | Recorded on each claim; set by Claude Code |
| `CLAUDE_PID` | The session process a claim is tied to; set by Claude Code for Bash |
| `HEADROOM_POLL_MS` | `wait` poll interval (default 2000) |
| `HEADROOM_QUIET_CPU` | Foreign CPU, in percent of one core, above which an exclusive grant is refused (default 150) |
| `HEADROOM_SAMPLE_MS` | Length of the CPU sample (default 1000) |
| `HEADROOM_PS` | A command printing `ps -Ao pid,ppid,time,comm`'s table, for another platform or a test |
