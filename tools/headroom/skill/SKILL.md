---
name: headroom
description: Use before running anything that pins the CPU for minutes — benchmarks, profiling, full builds, long test suites — and whenever the board (a `headroom` banner, a yield request, a waiting claim) shows up in your context. Claims shared resources on this machine so parallel agent sessions do not corrupt each other's measurements or crawl together.
---

# Headroom

Several agent sessions run on this machine at once. A benchmark next to a test suite measures the test suite. `headroom` is an advisory board: you claim a resource before heavy work, everyone sees the claim, and a session asked to yield stops. Nobody is blocked by it — informed sessions make the call.

## The one rule

Before CPU-heavy work, claim. After it, release. The easiest way is to run the work under the claim:

```
headroom run cpu --exclusive --why "JMH on the parser; another heavy process invalidates the run and it restarts from zero" -- ./gradlew jmh
```

`run` waits for its turn, holds and renews the claim for as long as the command runs, releases when it exits, and passes the command's exit code through. Run it in a background Bash call when the work is long, with `--timeout` covering the wait. If someone seizes the resource, `run` stops the command and exits 3 — so you never have to watch for a yield request yourself.

When the work spans several commands, claim by hand:

```
headroom acquire cpu --shared --ttl 15m --why "full suite, ~6 min, just slower if you join"
...work...
headroom release <id>
```

- `--exclusive` when another heavy process would **corrupt your result**: benchmarks, profiling, timing measurements.
- `--shared` when it would **only slow you down**: test suites, full builds, large recipe runs. Shared claims hold together.
- `--why` is read by other sessions deciding whether to wait, negotiate or override you. Say what you are doing *and what breaks if they proceed anyway*. "Running tests" tells them nothing; "full suite, ~6 min, just slower if you join" tells them everything.
- `--ttl` is your estimate. Running over? `headroom renew <id> --ttl 5m`. A claim nobody renews lapses at its ttl, **held or waiting** — a queued claim you walk away from disappears too, and an exclusive claim that lapses mid-benchmark lets the next session in while your numbers are still being taken. `run` renews for you; a hand-held claim is yours to renew.
- `--as` is the name other sessions message you by. Bifrost sessions have it in `BIFROST_SESSION_NAME`; elsewhere pass what `ListAgents` shows as "This session is …".

The MCP tools `headroom_acquire`, `headroom_release`, `headroom_renew`, `headroom_status`, `headroom_notice`, `headroom_seize` are the same commands; `run` is CLI only.

Exit codes: 0 granted or done · 1 queued, refused or lapsed · 2 wait timed out · 3 stopped for a yield request · otherwise the command's own.

## Queue order

Higher `--priority` goes first, then older claims first. A shared claim joins shared holders at once; an exclusive claim waits for the resource to empty, and while it waits no later shared claim slips past it. So the way to reserve a turn is to claim it: the queue is the reservation.

## Claim early

Claim as soon as you know you will need the resource, not when you reach that step. A queued claim holds your place, and an order agreed over messages ("Python perf first, then me, then the Spaces task") exists only in those messages until each party has a claim on the board. Hold the place with `headroom wait` or `headroom run`; a claim nobody renews lapses.

## When you release

`release` names whoever was granted next. A session sitting in `headroom wait` or `headroom run` picks the grant up within seconds; one that is idle sees it only at its next prompt, so tell it with `SendMessage` when it matters.

## When you are not granted

`acquire` prints who holds the resource, who is ahead of you, and the names `SendMessage` takes. Choose:

1. **Wait** — `headroom wait <id>` blocks until granted and keeps your claim alive; exit 0 means granted, 2 means `--timeout` passed (default 9m; from a background Bash call `--timeout 40m` is fine), 1 means the claim lapsed. Do other work first if there is any; the queue holds your place as long as something renews the claim.
2. **Negotiate** — a shared holder may be happy to pause for your 3-minute benchmark; a benchmark holder may be 30 seconds from done. Ask them: `SendMessage` to the quoted name, say what you need and how long. Agree on an order between you; the board records whatever you then do.
3. **Proceed anyway** — only when their `--why` says your work does not hurt them (a shared holder who is "just slower") and you accept being slower too. Tell them first with `SendMessage`. Never proceed past an exclusive holder whose `--why` says you would corrupt their run.

## When asked to yield

Your context says `YIELD REQUESTED on cpu: <who> needs it now — <why>`. Someone seized the resource. Stop the work there, `headroom release <id>`, and tell the requester you are clear with `SendMessage`. Re-acquire afterwards; your claim goes back in the queue. If stopping is genuinely worse than continuing (two minutes from the end of a 40-minute run), say so to the requester instead of silently continuing.

## Seizing

`headroom seize cpu --why "..."` puts you ahead of the queue and asks every holder to yield. It is for work that cannot wait. Holders see the request on their next prompt, which may be minutes away; `SendMessage` each name the command prints, then `headroom wait <id>`. After your release, everything resumes in queue order.

## Notices

A notice is a condition, not a claim: `headroom notice cpu --why "on generator power until ~15:00, prefer targeted tests"`. Nobody holds it, but no new claim is granted while it stands. Usually posted by the user. If you see one, do what it says.

## Reading the board

`headroom status` shows every resource with holders, waiters, reasons and time left. The same text is injected into your context by a hook, so what you see at the top of a prompt is the board as of that moment.
