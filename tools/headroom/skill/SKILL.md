---
name: headroom
description: Use before running anything that pins the CPU for minutes — benchmarks, profiling, full builds, long test suites — and whenever the board (a `headroom` banner, a yield request, a waiting claim) shows up in your context. Also when the user asks to restrict what runs on this machine, such as one thing at a time on battery, or to lift such a restriction. Claims shared resources on this machine so parallel agent sessions do not corrupt each other's measurements or crawl together.
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

**Claim the heavy work, not the time around it.** A claim held across idle gaps — a three-hour shared claim for work that runs in bursts, an exclusive claim kept while you read results — holds everyone else out of a CPU nobody is using. Claim per burst: `run` around each command does this by itself, and for a bare claim, release when the burst ends and claim again for the next. The one exception is a measurement whose rounds must not be split by other load — an interleaved A/B — which is held as one claim for exactly its rounds; if it is long, `headroom release <id> --requeue` between rounds lets a waiter in and puts you back in line. A short claim that is renewed when needed beats a long one that is guessed.

Anything under about 30 seconds of CPU — a quick grep, a single test class — runs unclaimed. Builds, suites, benchmarks and profiles are claimed, however short they look.

- `--exclusive` when another heavy process would **corrupt your result**: benchmarks, profiling, timing measurements.
- `--shared` when it would **only slow you down**: test suites, full builds, large recipe runs. Shared claims hold together, unless a notice is making work take turns.
- `--why` is read by other sessions deciding whether to wait, negotiate or override you. Say what you are doing *and what breaks if they proceed anyway*. "Running tests" tells them nothing; "full suite, ~6 min, just slower if you join" tells them everything.
- `--ttl` is your estimate. Running over? `headroom renew <id> --ttl 5m`. A claim nobody renews lapses at its ttl, **held or waiting** — a queued claim you walk away from disappears too, and an exclusive claim that lapses mid-benchmark lets the next session in while your numbers are still being taken. `run` and `hold` renew for you; a bare claim is yours to renew.
- `renew --why "round 3 of 5, ~10 min left"` restates your reason on the board. That is how progress and revised estimates reach the sessions waiting on you, instead of them asking.
- `--as` is the name other sessions message you by: what `ListAgents` shows as "This session is …". Sessions started by Bifrost have it set already; if you are refused for lack of a name, pass it.

Exit codes: 0 granted or done · 1 queued, refused or lapsed · 2 wait timed out · 3 stopped for a yield request · 4 refused because the machine is busy outside any claim · otherwise the command's own. A script keys on the exit code, never on the text, which is written for people. `acquire -q` prints only the claim id, for `$(...)`.

## When the machine is busy outside the board

An exclusive claim is granted only onto a quiet machine. Before handing it over, headroom samples the CPU for a second; if processes under no claim — and not your own — are burning more than about 1.5 cores, the claim is refused (exit 4) and the output names them with their pids:

```
refused #7 — cpu is 480% busy outside any claim: java 410% (pid 4123), node 70% (pid 4190).
```

That is work nobody claimed, so the board cannot tell you whose it is. Find out before deciding: `ps -p 4123 -o pid,ppid,command` says what it is, and `ListAgents` plus a `SendMessage` finds the session running it. Then acquire again once it is done, or `--force` if you have decided it does not matter to your measurement. `run` and `wait` apply the same check at the moment of grant. Shared claims are never refused for load; they tolerate it by definition.

## Queue order

Higher `--priority` goes first, then older claims first. A shared claim joins shared holders at once; an exclusive claim waits for the resource to empty, and while it waits no later shared claim slips past it. So the way to reserve a turn is to claim it: the queue is the reservation.

A grant is an offer until you start on it, and it is yours alone for about a minute. Start inside that and the resource is held for you until you release it. Leave it and the next claim is offered the resource as well, so whichever session is ready to work takes it and the other goes back to the queue with its place intact. `run` and `hold` start the claim by running something under it, and `renew` starts a bare one, which is all a session has to do to say it is still on this. So nothing is taken off you for being slow — only for not being there.

## Claim early

Claim as soon as you know you will need the resource, not when you reach that step. A queued claim holds your place, and an order agreed over messages ("Python perf first, then me, then the Spaces task") exists only in those messages until each party has a claim on the board. Hold the place with `headroom wait` or `headroom run`; a claim nobody renews lapses.

## When you release

`release` names whoever was granted next. A session sitting in `headroom wait` or `headroom run` picks the grant up within seconds. An idle one sees it only at its next prompt, which is usually longer than the offer stands, so tell it with `SendMessage` when the order matters to you.

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

A notice is a condition, not a claim. Nobody holds it, and it says how much may run while it stands. Usually posted by the user, and the board shows it with its id so it can be lifted.

```
headroom notice cpu --why "on generator power until ~15:00, prefer targeted tests"
headroom notice cpu --serial --ttl 3h --why "on battery — one claim at a time"
headroom clear <id>
```

Plain, nothing new is granted at all. With `--serial`, work still runs but only one claim at a time, so `--shared` stops meaning "beside the others" and a suite waits its turn instead of draining the battery alongside two more. Ask for what you are actually doing either way: the notice does the restricting, not your flags.

Either kind leaves the claims already running alone and takes effect as they finish. To quiet the machine now, that is `seize`. To lift a notice, `headroom clear <id>` with the id from the board, or let its `--ttl` run out.

**The user asks for this in their own words** — "we're on battery", "stop everything for a bit", "make the agents take turns". That is a notice, and lifting it is the same conversation in reverse ("I'm plugged in again").

## Reading the board

`headroom status` shows every resource with holders, waiters, reasons and time left, then a one-second sample of how busy the machine is and the heaviest processes that belong to no claim — the check for whether a grant actually bought quiet. A hook injects the board into your context at session start, whenever it changed since you last saw it, and on every prompt while you hold or wait on a claim; a prompt with no board attached means nothing changed.
