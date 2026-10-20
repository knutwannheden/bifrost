# headroom

Advisory claims on shared resources, so parallel agent sessions on one machine do not run a benchmark on top of a test suite. One SQLite file, a CLI, an MCP server over the same commands, and a hook that puts the board in front of every session.

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

There is no server. Each command opens the SQLite file, settles the queue under a write lock, and exits. Cleanup needs no sweeper either: a claim records its session's process id and is dropped the next time anyone looks after that process is gone, and a claim nobody renews lapses at its ttl whether held or waiting.

Requires Node 24 (built-in `node:sqlite`, runs `.ts` directly).

## Install

```
cd tools/headroom && npm install
ln -s "$PWD/src/cli.ts" ~/.local/bin/headroom     # or anywhere on PATH
ln -s "$PWD/skill" ~/.claude/skills/headroom
```

`run` wraps a command: it waits for the claim, renews it while the command runs, releases on exit, and stops the command (exit 3) when the claim is asked to yield. Exit codes otherwise: 0 granted or done, 1 queued, refused or lapsed, 2 wait timed out, else the command's own.

Register the MCP server in `~/.claude.json` as a stdio server, or use the CLI alone — they are the same commands. Use absolute paths: Claude Code spawns the server with the launching app's PATH, which under an Electron app is not your shell's.

```json
"headroom": { "type": "stdio", "command": "/abs/path/to/node", "args": ["/abs/path/to/tools/headroom/src/cli.ts", "mcp", "serve"] }
```

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
| `CLAUDE_PID` | The session process a claim is tied to; set by Claude Code for Bash, the MCP server uses its parent |
| `HEADROOM_POLL_MS` | `wait` poll interval (default 2000) |
