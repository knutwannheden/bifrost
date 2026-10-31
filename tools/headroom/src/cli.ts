#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Board, type Claim, type ClaimInput, type Mode } from './board.ts';
import {
  busyRefusal,
  formatLeft,
  granted,
  holderName,
  nextUp,
  parseDuration,
  queued,
  sessionPid,
  signature,
} from './common.ts';
import { hookOutput, waitingBehind } from './hook.ts';
import { describeLoad, sampleForeignLoad } from './machine.ts';

const USAGE = `headroom — advisory claims on shared resources, for agent sessions on one machine

  headroom run <resource> --shared|--exclusive --why "..." [--ttl 10m] [--grace 0] [--as name] -- <command...>
      acquire, wait your turn, hold while the command runs, release on exit
  headroom acquire <resource> --shared|--exclusive --why "..." [--ttl 10m] [--priority N] [--wait] [--as name] [-q] [--force]
  headroom hold <id> [--grace 0|3m|never] -- <command...>
      keep the claim alive while the command runs, and act on a yield request
  headroom wait <id> [--timeout 40m]
  headroom renew <id> [--ttl 10m] [--why "..."]
  headroom release <id> [--requeue]        --requeue lets the next in line run and files the claim right behind it
      (clear <id> is the same thing, for lifting a notice)
  headroom notice <resource> --why "..." [--serial] [--ttl 1h] [--as name]
      --serial lets work through one claim at a time instead of stopping it; without it nothing new runs
  headroom seize <resource> --why "..." [--ttl 10m] [--as name]
  headroom status [resource] [--json]
  headroom hook                      reads a Claude Code hook event on stdin

shared: any number hold together (test suites, builds). exclusive: holds alone (benchmarks, profiling).
--why says what you are doing and what breaks if someone proceeds anyway; renew --why restates it.
--as is the name other sessions message you by; Bifrost sessions have it in BIFROST_SESSION_NAME.
-q prints only the claim id, for $(...) and && chains.

On a yield request, hold and run write a marker file whose path the command has in $HEADROOM_YIELD, then
stop the command's process group when --grace runs out: 0 stops at once, 3m lets a loop finish its rep,
never only warns. A loop checks the marker between reps: [ -e "$HEADROOM_YIELD" ] && break

An exclusive claim is granted only onto a quiet machine: if processes outside every claim, each busy at least half
a core, together burn more than HEADROOM_QUIET_CPU percent of a core (default 150) over a three-second sample, the
claim is refused with their pids, so you can find out what they are. --force takes the claim anyway.

Exit codes: 0 granted or done · 1 queued, refused or lapsed · 2 wait timed out · 3 stopped for a yield request
            · 4 refused because the machine is busy outside any claim · otherwise the command's own.
Scripts key on the exit code; the text is for people.
A waiting claim lapses unless renewed; wait, hold and run renew it while they poll. wait has no cutoff
unless --timeout is given. A grant is an offer for about a minute: run and hold start on it, renew starts
a bare claim, and an offer nobody starts is made to the next in line too, whoever is ready first taking it.
Environment: HEADROOM_DB (default ~/.headroom/board.db), HEADROOM_AS, BIFROST_SESSION_NAME.`;

function dbFile(): string {
  return process.env.HEADROOM_DB ?? join(homedir(), '.headroom', 'board.db');
}

function openBoard(): Board {
  mkdirSync(dirname(dbFile()), { recursive: true });
  return Board.open(dbFile());
}

function pollMs(): number {
  return Number(process.env.HEADROOM_POLL_MS ?? 2000);
}

async function waitFor(board: Board, id: number, timeoutMs: number, force = false): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const c = board.get(id);
    if (!c || c.releasedAt !== null) {
      console.log(`claim #${id} is gone — acquire again`);
      return 1;
    }
    if (c.grantedAt !== null) {
      const refusal = c.mode === 'exclusive' && !force ? await busyRefusal(board, c) : null;
      if (refusal) {
        board.release(id);
        console.log(refusal);
        return 4;
      }
      console.log(granted(board, c));
      return 0;
    }
    if (Date.now() >= deadline) {
      console.log(`still waiting #${id} after ${formatLeft({ ...c, expiresAt: Date.now() + timeoutMs }, Date.now())}.`);
      console.log(queued(board, c));
      return 2;
    }
    // A waiting claim lapses unless tended, so the wait is what keeps it alive.
    board.renew(id, c.ttlMs);
    await new Promise((r) => setTimeout(r, pollMs()));
  }
}

/**
 * Keeps the claim alive while the command runs. On a yield request the command
 * is told through a marker file, then its process group is stopped once the
 * grace period is over. The claim itself is left to the caller.
 */
async function holdWhile(board: Board, id: number, cmd: string[], graceMs: number | null): Promise<number> {
  const marker = join(dirname(dbFile()), `yield-${id}`);
  rmSync(marker, { force: true });
  console.error(`headroom: holding #${id} for: ${cmd.join(' ')}`);
  // While held here, the claim lives and dies with this wrapper rather than
  // the session, so a killed hold frees the resource on the next look.
  const owner = board.get(id)?.pid ?? sessionPid();
  board.attach(id, process.pid, true);
  // Another session can start on the resource in the moment between the grant
  // and this hold, which leaves the claim queued while the command runs anyway.
  if (board.get(id)?.grantedAt === null) {
    console.error(`headroom: #${id} was taken by another session first — running unclaimed, so expect company`);
  }

  const child = spawn(cmd[0]!, cmd.slice(1), {
    stdio: 'inherit',
    detached: true,
    env: { ...process.env, HEADROOM_YIELD: marker },
  });
  const stop = () => {
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  };

  let stoppedForYield = false;
  let yieldSeen = false;
  let graceTimer: NodeJS.Timeout | undefined;
  const tick = setInterval(() => {
    const c = board.get(id);
    if (!c || c.releasedAt !== null) return;
    if (c.yieldRequestedBy !== null && !yieldSeen) {
      yieldSeen = true;
      const seizer = board.get(c.yieldRequestedBy);
      const who = `${seizer?.holder ?? 'another session'}${seizer ? `: ${seizer.why}` : ''}`;
      writeFileSync(marker, `${who}\n`);
      const action =
        graceMs === null ? 'warning only' : graceMs === 0 ? 'stopping now' : `stopping in ${graceMs / 1000}s`;
      console.error(`headroom: YIELD REQUESTED by ${who} — ${action}: ${cmd.join(' ')}`);
      if (graceMs !== null) {
        graceTimer = setTimeout(() => {
          stoppedForYield = true;
          stop();
        }, graceMs);
      }
    }
    board.renew(id, c.ttlMs);
  }, pollMs());
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const code = await new Promise<number>((resolve) => {
    child.on('error', (e) => {
      console.error(`headroom: ${e.message}`);
      resolve(127);
    });
    child.on('exit', (exitCode, sig) => resolve(exitCode ?? (sig === 'SIGTERM' ? 143 : 1)));
  });
  clearInterval(tick);
  if (graceTimer) clearTimeout(graceTimer);
  rmSync(marker, { force: true });
  if (board.get(id)?.releasedAt === null) board.attach(id, owner);
  return stoppedForYield ? 3 : code;
}

async function runUnderClaim(
  board: Board,
  input: ClaimInput,
  cmd: string[],
  graceMs: number | null,
  timeoutMs: number,
  force: boolean,
): Promise<number> {
  const claim = board.claim(input);
  const refusal =
    claim.grantedAt !== null && claim.mode === 'exclusive' && !force ? await busyRefusal(board, claim) : null;
  if (refusal) {
    board.release(claim.id);
    console.error(refusal);
    return 4;
  }
  if (claim.grantedAt === null) {
    console.error(queued(board, claim));
    const code = await waitFor(board, claim.id, timeoutMs, force);
    if (code !== 0) {
      // Nothing ran, so there is no place in the queue worth keeping.
      board.release(claim.id);
      return code;
    }
  }
  try {
    return await holdWhile(board, claim.id, cmd, graceMs);
  } finally {
    board.release(claim.id);
    console.error(`headroom: released #${claim.id}`);
  }
}

function parseGrace(text: string): number | null {
  return text === 'never' ? null : parseDuration(text);
}

/** Whether this session is shown the board now: at session start, while it has a claim, or when the board changed since it last looked. */
function shouldInject(session: string | null, event: string | undefined, board: Board): boolean {
  const status = board.status();
  const claims = [...status.notices, ...status.holding, ...status.waiting];
  if (event === 'SessionStart') return true;
  if (session && claims.some((c) => c.sessionId === session)) return true;
  if (!session) return true;
  const seenDir = join(dirname(dbFile()), 'seen');
  const seenFile = join(seenDir, session.replace(/[^\w-]/g, '_'));
  const now = signature(claims);
  let last = '';
  try {
    last = readFileSync(seenFile, 'utf8');
  } catch {}
  mkdirSync(seenDir, { recursive: true });
  writeFileSync(seenFile, now);
  return now !== last;
}

/**
 * The sessions waiting behind a claim this session holds that it has not been
 * told of yet, so a holder hears of each waiter once however many tools it runs.
 */
function newlyWaitingBehind(session: string, board: Board): { held: Claim; waiters: Claim[] } | null {
  const status = board.status();
  const held = status.holding.find((c) => c.sessionId === session);
  if (!held) return null;
  const waiters = status.waiting.filter((c) => c.resource === held.resource && c.sessionId !== session);
  const toldFile = join(dirname(dbFile()), 'seen', `${session.replace(/[^\w-]/g, '_')}.behind`);
  let told: number[] = [];
  try {
    told = JSON.parse(readFileSync(toldFile, 'utf8'));
  } catch {}
  mkdirSync(dirname(toldFile), { recursive: true });
  writeFileSync(toldFile, JSON.stringify(waiters.map((c) => c.id)));
  const fresh = waiters.filter((c) => !told.includes(c.id));
  return fresh.length ? { held, waiters: fresh } : null;
}

async function main(argv: string[]): Promise<number> {
  const dashes = argv.indexOf('--');
  const cmd = dashes >= 0 ? argv.slice(dashes + 1) : [];
  const { values, positionals } = parseArgs({
    args: dashes >= 0 ? argv.slice(0, dashes) : argv,
    allowPositionals: true,
    options: {
      shared: { type: 'boolean' },
      exclusive: { type: 'boolean' },
      why: { type: 'string' },
      ttl: { type: 'string' },
      priority: { type: 'string' },
      wait: { type: 'boolean' },
      timeout: { type: 'string' },
      grace: { type: 'string', default: '0' },
      requeue: { type: 'boolean' },
      serial: { type: 'boolean' },
      force: { type: 'boolean' },
      as: { type: 'string' },
      quiet: { type: 'boolean', short: 'q' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const timeoutMs = values.timeout ? parseDuration(values.timeout) : Number.POSITIVE_INFINITY;

  /** The claim acquire and run both make from the flags. */
  const claimInput = async (): Promise<ClaimInput> => {
    if (!arg) throw new Error(`${command} needs a resource name, e.g. cpu`);
    if (values.shared === values.exclusive) throw new Error('Pass exactly one of --shared or --exclusive');
    if (!values.why) throw new Error('Pass --why: what you are doing, and what breaks if someone proceeds anyway');
    const mode: Mode = values.shared ? 'shared' : 'exclusive';
    return {
      resource: arg,
      mode,
      holder: await holderName(values.as),
      sessionId: process.env.CLAUDE_CODE_SESSION_ID,
      pid: sessionPid(),
      why: values.why,
      priority: values.priority ? Number(values.priority) : 0,
      ttlMs: parseDuration(values.ttl ?? '10m'),
    };
  };

  const board = openBoard();
  try {
    switch (command) {
      case 'run': {
        if (cmd.length === 0) throw new Error('run needs a command after --');
        return await runUnderClaim(
          board,
          await claimInput(),
          cmd,
          parseGrace(values.grace),
          timeoutMs,
          values.force ?? false,
        );
      }
      case 'hold': {
        if (cmd.length === 0) throw new Error('hold needs a command after --');
        return await holdWhile(board, Number(arg), cmd, parseGrace(values.grace));
      }
      case 'acquire': {
        const claim = board.claim(await claimInput());
        if (claim.grantedAt !== null) {
          const refusal = claim.mode === 'exclusive' && !values.force ? await busyRefusal(board, claim) : null;
          if (refusal) {
            board.release(claim.id);
            console.log(refusal);
            return 4;
          }
          console.log(values.quiet ? claim.id : granted(board, claim));
          return 0;
        }
        if (values.wait) return await waitFor(board, claim.id, timeoutMs, values.force ?? false);
        console.log(values.quiet ? claim.id : queued(board, claim));
        return 1;
      }
      case 'wait':
        return await waitFor(board, Number(arg), timeoutMs, values.force ?? false);
      case 'renew': {
        const c = board.renew(Number(arg), parseDuration(values.ttl ?? '10m'), values.why);
        console.log(c.grantedAt !== null ? granted(board, c) : queued(board, c));
        return 0;
      }
      case 'release':
      case 'clear': {
        if (values.requeue) {
          const { next, claim } = board.requeue(Number(arg));
          console.log(`released #${arg}${nextUp(next)}`);
          console.log(claim.grantedAt !== null ? granted(board, claim) : queued(board, claim));
          return 0;
        }
        console.log(`released #${arg}${nextUp(board.release(Number(arg)))}`);
        return 0;
      }
      case 'notice': {
        if (!arg || !values.why) throw new Error('notice needs a resource and --why');
        const c = board.claim({
          resource: arg,
          mode: 'notice',
          holder: await holderName(values.as, 'notice'),
          why: values.why,
          ttlMs: parseDuration(values.ttl ?? '1h'),
          holderLimit: values.serial ? 1 : 0,
        });
        console.log(
          `notice #${c.id} on ${c.resource} for ${formatLeft(c, Date.now())} — ` +
            `${values.serial ? 'one claim at a time' : 'nothing new runs'}. Lift it with: headroom clear ${c.id}`,
        );
        return 0;
      }
      case 'seize': {
        if (!arg || !values.why) throw new Error('seize needs a resource and --why');
        const { claim, yielding } = board.seize({
          resource: arg,
          holder: await holderName(values.as),
          sessionId: process.env.CLAUDE_CODE_SESSION_ID,
          pid: sessionPid(),
          why: values.why,
          ttlMs: parseDuration(values.ttl ?? '10m'),
        });
        if (claim.grantedAt !== null) {
          console.log(granted(board, claim));
          return 0;
        }
        console.log(`seizing #${claim.id} — asked to yield: ${yielding.map((c) => `"${c.holder}"`).join(', ')}.`);
        console.log('Tell them with SendMessage; a holder in headroom hold or run acts on it within seconds.');
        console.log(`Then: headroom wait ${claim.id}`);
        return 1;
      }
      case 'status': {
        const status = board.status(arg);
        if (values.json) {
          console.log(JSON.stringify(status, null, 2));
          return 0;
        }
        const out = hookOutput(status, null, Date.now());
        const load = await sampleForeignLoad(status.holding.map((c) => c.pid).filter((p): p is number => p !== null));
        const machine = 'error' in load ? `could not sample (${load.error})` : describeLoad(load);
        console.log(`${out ? out.hookSpecificOutput.additionalContext : 'nothing claimed'}\nMachine: ${machine}`);
        return 0;
      }
      case 'hook': {
        const input = await new Promise<string>((r) => {
          let s = '';
          process.stdin.on('data', (d) => (s += d));
          process.stdin.on('end', () => r(s));
        });
        const event = input.trim() ? JSON.parse(input) : {};
        const session = event.session_id ?? null;
        if (event.hook_event_name === 'PostToolUse') {
          const behind = session ? newlyWaitingBehind(session, board) : null;
          if (behind) console.log(JSON.stringify(waitingBehind(behind.held, behind.waiters)));
          return 0;
        }
        if (!shouldInject(session, event.hook_event_name, board)) return 0;
        const out = hookOutput(board.status(), session, Date.now(), event.hook_event_name);
        if (out) console.log(JSON.stringify(out));
        return 0;
      }
      default:
        console.error(`Unknown command "${command}"\n\n${USAGE}`);
        return 1;
    }
  } finally {
    board.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
