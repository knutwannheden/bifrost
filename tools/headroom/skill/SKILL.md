---
name: headroom
description: Use before running anything that pins the CPU for minutes — benchmarks, profiling, full builds, long test suites — and whenever the board (a `headroom` banner, a yield request, a waiting claim) shows up in your context. Claims shared resources on this machine so parallel agent sessions do not corrupt each other's measurements or crawl together.
---

# Headroom

Several agent sessions run on this machine at once. A benchmark next to a test suite measures the test suite. `headroom` is an advisory board: you claim a resource before heavy work, everyone sees the claim, and a session asked to yield stops. Nobody is blocked by it — informed sessions make the call.

## The one rule

Before CPU-heavy work, claim. After it, release. The easiest way is to run the work under the claim:

```
headroom run cpu --exclusive --as "<your session name>" --why "JMH on the parser; another heavy process invalidates the run and it restarts from zero. If you overlapped me, tell me so I can discard the rep" -- ./gradlew jmh
```

`run` waits for its turn, holds and renews the claim for as long as the command runs, releases when it exits, and passes the command's exit code through. Run it in a background Bash call when the work is long. If someone seizes the resource, `run` stops the command and exits 3 — so you never have to watch for a yield request yourself.

When the work spans several commands, claim by hand and wrap each heavy command in `hold`, which keeps the claim alive and watches for a yield while that command runs:

```
id=$(headroom acquire cpu --exclusive --as "<your session name>" --why "..." -q)
headroom hold $id -- ./gradlew jmh -Pround=1
headroom hold $id -- ./gradlew jmh -Pround=2
headroom release $id
```

Hold **one claim across all rounds** of a measurement. Releasing between rounds makes "done, or between rounds?" a question again for everyone else; if you do want to let others in between rounds, `headroom release <id> --requeue` puts you at the back of the queue in one step.

Anything under about 30 seconds of CPU — a quick grep, a single test class — runs unclaimed. Builds, suites, benchmarks and profiles are claimed, however short they look.

- `--exclusive` when another heavy process would **corrupt your result**: benchmarks, profiling, timing measurements.
- `--shared` when it would **only slow you down**: test suites, full builds, large recipe runs. Shared claims hold together.
- `--why` is read by other sessions deciding whether to wait, negotiate or override you. Say what you are doing *and what breaks if they proceed anyway*. "Running tests" tells them nothing; "full suite, ~6 min, just slower if you join" tells them everything.
- `--ttl` is your estimate. Running over? `headroom renew <id> --ttl 5m`. A claim nobody renews lapses at its ttl, **held or waiting** — a queued claim you walk away from disappears too, and an exclusive claim that lapses mid-benchmark lets the next session in while your numbers are still being taken. `run` and `hold` renew for you; a bare claim is yours to renew.
- `renew --why "round 3 of 5, ~10 min left"` restates your reason on the board. That is how progress and revised estimates reach the sessions waiting on you, instead of them asking.
- `--as` is the name other sessions message you by: what `ListAgents` shows as "This session is …". Sessions started by Bifrost have it set already; if you are refused for lack of a name, pass it.

The MCP tools `headroom_acquire`, `headroom_release`, `headroom_renew`, `headroom_status`, `headroom_notice`, `headroom_seize` are the same commands; `run` and `hold` are CLI only.

Exit codes: 0 granted or done · 1 queued, refused or lapsed · 2 wait timed out · 3 stopped for a yield request · otherwise the command's own. A script keys on the exit code, never on the text, which is written for people. `acquire -q` prints only the claim id, for `$(...)`.

## Queue order

Higher `--priority` goes first, then older claims first. A shared claim joins shared holders at once; an exclusive claim waits for the resource to empty, and while it waits no later shared claim slips past it. So the way to reserve a turn is to claim it: the queue is the reservation.

## Claim early

Claim as soon as you know you will need the resource, not when you reach that step. A queued claim holds your place, and an order agreed over messages ("Python perf first, then me, then the Spaces task") exists only in those messages until each party has a claim on the board. Hold the place with `headroom wait` or `headroom run`; a claim nobody renews lapses.

## When you release

`release` names whoever was granted next. A session sitting in `headroom wait` or `headroom run` picks the grant up within seconds; one that is idle sees it only at its next prompt, so tell it with `SendMessage` when it matters.

## When you are not granted

`acquire` prints who holds the resource, who is ahead of you, and the names `SendMessage` takes. Choose:

1. **Wait** — `headroom wait <id>` blocks until granted and keeps your claim alive. It has no cutoff of its own, so run it in a background Bash call; `--timeout` adds one if you want it (exit 2). Exit 0 means granted, 1 means the claim lapsed. The queued output says where you are in line. Do other work first if there is any; the queue holds your place as long as something renews the claim.
2. **Negotiate** — a shared holder may be happy to pause for your 3-minute benchmark; a benchmark holder may be 30 seconds from done. Ask them: `SendMessage` to the quoted name, say what you need and how long. Agree on an order between you; the board records whatever you then do.
3. **Proceed anyway** — only when their `--why` says your work does not hurt them (a shared holder who is "just slower") and you accept being slower too. Tell them first with `SendMessage`. Never proceed past an exclusive holder whose `--why` says you would corrupt their run.

## When asked to yield

Your context says `YIELD REQUESTED on cpu: <who> needs it now — <why>`. Someone seized the resource. Stop the work there, `headroom release <id>`, and tell the requester you are clear with `SendMessage`. Re-acquire afterwards; your claim goes back in the queue. If stopping is genuinely worse than continuing (two minutes from the end of a 40-minute run), say so to the requester instead of silently continuing.

Under `run` or `hold` this is handled for you, and `--grace` decides how: `0` (the default) stops the command's whole process tree at once; `--grace 3m` first writes a marker file whose path the command has in `$HEADROOM_YIELD`, so a loop can finish its current rep and stop cleanly — `[ -e "$HEADROOM_YIELD" ] && break` between reps — and is stopped only when the grace runs out; `--grace never` only warns. Use a grace for an A/B whose completed reps are worth keeping; a run that is invalid the moment anything else starts gets the default.

## Seizing

`headroom seize cpu --why "..."` puts you ahead of the queue and asks every holder to yield. It is for work that cannot wait. Holders see the request on their next prompt, which may be minutes away; `SendMessage` each name the command prints, then `headroom wait <id>`. After your release, everything resumes in queue order.

## Notices

A notice is a condition, not a claim: `headroom notice cpu --why "on generator power until ~15:00, prefer targeted tests"`. Nobody holds it, but no new claim is granted while it stands. Usually posted by the user. If you see one, do what it says.

## Reading the board

`headroom status` shows every resource with holders, waiters, reasons and time left, then a one-second sample of how busy the machine is and the heaviest processes that belong to no claim — the check for whether a grant actually bought quiet. A hook injects the board into your context at session start, whenever it changed since you last saw it, and on every prompt while you hold or wait on a claim; a prompt with no board attached means nothing changed.
