#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { Board, type ClaimInput, type Mode } from './board.ts';
import { formatLeft, granted, holderName, nextUp, parseDuration, queued, sessionPid } from './common.ts';
import { hookOutput } from './hook.ts';

const USAGE = `headroom — advisory claims on shared resources, for agent sessions on one machine

  headroom run <resource> --shared|--exclusive --why "..." [--ttl 10m] [--timeout 9m] [--as name] -- <command...>
      waits for the claim, holds and renews it while the command runs, releases on exit
  headroom acquire <resource> --shared|--exclusive --why "..." [--ttl 10m] [--priority N] [--wait] [--as name]
  headroom wait <id> [--timeout 9m]
  headroom renew <id> [--ttl 10m]
  headroom release <id>
  headroom notice <resource> --why "..." [--ttl 1h] [--as name]
  headroom seize <resource> --why "..." [--ttl 10m] [--as name]
  headroom status [resource] [--json]
  headroom hook                      reads a Claude Code hook event on stdin
  headroom mcp serve

shared: any number hold together (test suites, builds). exclusive: holds alone (benchmarks, profiling).
--why says what you are doing and what breaks if someone proceeds anyway.
--as is the name other sessions message you by; Bifrost sessions have it in BIFROST_SESSION_NAME.

Exit codes: 0 granted or done · 1 queued, refused or lapsed · 2 wait timed out · 3 stopped for a yield request
            · otherwise the command's own.
A waiting claim lapses unless renewed; wait and run renew it while they poll. From a background Bash call,
--timeout 40m is fine. Environment: HEADROOM_DB (default ~/.headroom/board.db), HEADROOM_AS, BIFROST_SESSION_NAME.`;

function openBoard(): Board {
  const file = process.env.HEADROOM_DB ?? join(homedir(), '.headroom', 'board.db');
  mkdirSync(dirname(file), { recursive: true });
  return Board.open(file);
}

async function waitFor(board: Board, id: number, timeoutMs: number): Promise<number> {
  const poll = Number(process.env.HEADROOM_POLL_MS ?? 2000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const c = board.get(id);
    if (!c || c.releasedAt !== null) {
      console.log(`claim #${id} is gone — acquire again`);
      return 1;
    }
    if (c.grantedAt !== null) {
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
    await new Promise((r) => setTimeout(r, poll));
  }
}

/** Holds the claim for as long as the command runs, and stops the command when asked to yield. */
async function runUnderClaim(board: Board, input: ClaimInput, cmd: string[], timeoutMs: number): Promise<number> {
  const claim = board.claim(input);
  if (claim.grantedAt === null) {
    console.error(queued(board, claim));
    const code = await waitFor(board, claim.id, timeoutMs);
    if (code !== 0) {
      // Nothing ran, so there is no place in the queue worth keeping.
      board.release(claim.id);
      return code;
    }
  }
  console.error(`headroom: holding #${claim.id} ${input.resource} ${input.mode} for: ${cmd.join(' ')}`);

  const child = spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit' });
  let stoppedForYield = false;
  const poll = Number(process.env.HEADROOM_POLL_MS ?? 2000);
  const tick = setInterval(() => {
    const c = board.get(claim.id);
    if (!c || c.releasedAt !== null) return;
    if (c.yieldRequestedBy !== null) {
      const seizer = board.get(c.yieldRequestedBy);
      console.error(
        `headroom: YIELD REQUESTED by ${seizer?.holder ?? 'another session'}${seizer ? `: ${seizer.why}` : ''}. Stopping ${cmd[0]}.`,
      );
      stoppedForYield = true;
      child.kill('SIGTERM');
      return;
    }
    board.renew(claim.id, c.ttlMs);
  }, poll);
  const forward = () => child.kill('SIGTERM');
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);

  const code = await new Promise<number>((resolve) => {
    child.on('error', (e) => {
      console.error(`headroom: ${e.message}`);
      resolve(127);
    });
    child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal === 'SIGTERM' ? 143 : 1)));
  });
  clearInterval(tick);
  board.release(claim.id);
  console.error(`headroom: released #${claim.id}`);
  return stoppedForYield ? 3 : code;
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
      timeout: { type: 'string', default: '9m' },
      as: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  if (command === 'mcp') {
    const { serve } = await import('./mcp.ts');
    await serve(openBoard());
    return 0;
  }

  /** The claim acquire and run both make from the flags. */
  const claimInput = (): ClaimInput => {
    if (!arg) throw new Error(`${command} needs a resource name, e.g. cpu`);
    if (values.shared === values.exclusive) throw new Error('Pass exactly one of --shared or --exclusive');
    if (!values.why) throw new Error('Pass --why: what you are doing, and what breaks if someone proceeds anyway');
    const mode: Mode = values.shared ? 'shared' : 'exclusive';
    return {
      resource: arg,
      mode,
      holder: holderName(values.as),
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
        return await runUnderClaim(board, claimInput(), cmd, parseDuration(values.timeout));
      }
      case 'acquire': {
        const claim = board.claim(claimInput());
        if (claim.grantedAt !== null) {
          console.log(granted(board, claim));
          return 0;
        }
        if (values.wait) return await waitFor(board, claim.id, parseDuration(values.timeout));
        console.log(queued(board, claim));
        return 1;
      }
      case 'wait':
        return await waitFor(board, Number(arg), parseDuration(values.timeout));
      case 'renew': {
        const c = board.renew(Number(arg), parseDuration(values.ttl ?? '10m'));
        console.log(c.grantedAt !== null ? granted(board, c) : queued(board, c));
        return 0;
      }
      case 'release':
      case 'clear':
        console.log(`released #${arg}${nextUp(board.release(Number(arg)))}`);
        return 0;
      case 'notice': {
        if (!arg || !values.why) throw new Error('notice needs a resource and --why');
        const c = board.claim({
          resource: arg,
          mode: 'notice',
          holder: holderName(values.as, 'notice'),
          why: values.why,
          ttlMs: parseDuration(values.ttl ?? '1h'),
        });
        console.log(
          `notice #${c.id} on ${c.resource} for ${formatLeft(c, Date.now())}. Lift it with: headroom clear ${c.id}`,
        );
        return 0;
      }
      case 'seize': {
        if (!arg || !values.why) throw new Error('seize needs a resource and --why');
        const { claim, yielding } = board.seize({
          resource: arg,
          holder: holderName(values.as),
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
        console.log('Tell them with SendMessage; they see the request on their next prompt or renew either way.');
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
        console.log(out ? out.hookSpecificOutput.additionalContext : 'nothing claimed');
        return 0;
      }
      case 'hook': {
        const input = await new Promise<string>((r) => {
          let s = '';
          process.stdin.on('data', (d) => (s += d));
          process.stdin.on('end', () => r(s));
        });
        const event = input.trim() ? JSON.parse(input) : {};
        const out = hookOutput(board.status(), event.session_id ?? null, Date.now(), event.hook_event_name);
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
