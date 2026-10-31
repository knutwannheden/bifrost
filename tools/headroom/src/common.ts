import { basename } from 'node:path';
import { type Board, type Claim, idle } from './board.ts';
import { describeLoad, sampleForeignLoad } from './machine.ts';

export function formatLeft(claim: Claim, now: number): string {
  const ms = claim.expiresAt - now;
  if (ms <= 0) return 'expiring';
  const min = Math.ceil(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}` : `${min}m`;
}

/** How long a claim stands: a countdown for a bare claim, and no deadline at all for one a command renews. */
export function lifetime(claim: Claim, now: number): string {
  if (claim.renewing) return 'renewed while its command runs';
  const left = `${formatLeft(claim, now)} left`;
  return idle(claim) ? `${left}, idle so the next in line may run` : left;
}

export function parseDuration(text: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(text.trim());
  if (!m) throw new Error(`Bad duration "${text}" — use 90s, 10m, 1h`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, '': 60_000 }[m[2]]!;
}

/** The Claude Code session this process serves, which every Bash call is told. */
export function sessionPid(): number {
  return Number(process.env.CLAUDE_PID) || process.ppid;
}

/** The name Bifrost's local API has for this session, for a session started before Bifrost exported it. */
async function bifrostSessionName(): Promise<string | undefined> {
  const port = process.env.BIFROST_API_PORT;
  const session = process.env.CLAUDE_CODE_SESSION_ID;
  if (!port || !session) return undefined;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/find-task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: session }),
      signal: AbortSignal.timeout(1000),
    });
    const body = (await res.json()) as { ok?: boolean; sessionName?: string };
    return body.ok ? body.sessionName : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The name other sessions message this one by, which Bifrost exports for its
 * sessions. A notice needs no address, so it may fall back to the user's name.
 * A session with no name is listed by its directory and session id, which
 * says whose claim it is even though SendMessage cannot deliver to it.
 */
export async function holderName(as: string | undefined, kind: 'claim' | 'notice' = 'claim'): Promise<string> {
  const name = as ?? process.env.HEADROOM_AS ?? process.env.BIFROST_SESSION_NAME ?? (await bifrostSessionName());
  if (name) return name;
  if (kind === 'notice' && process.env.USER) return process.env.USER;
  const session = process.env.CLAUDE_CODE_SESSION_ID ?? String(sessionPid());
  return `${basename(process.cwd())}/${session.slice(0, 8)}`;
}

/**
 * The refusal for an exclusive claim granted onto a machine that something
 * outside the board is already pinning, or null when it is quiet enough. A
 * machine that cannot be sampled is reported, not refused.
 */
export async function busyRefusal(board: Board, claim: Claim): Promise<string | null> {
  const threshold = Number(process.env.HEADROOM_QUIET_CPU ?? 150);
  const holders = board
    .status(claim.resource)
    .holding.map((c) => c.pid)
    .filter((p): p is number => p !== null);
  const load = await sampleForeignLoad([...holders, sessionPid()]);
  if ('error' in load) {
    console.error(`headroom: could not sample the machine (${load.error}); granting unchecked`);
    return null;
  }
  if (load.percent < threshold) return null;
  return [
    `refused #${claim.id} — ${claim.resource} is ${describeLoad(load)}.`,
    'That is not on the board, so find out what it is and who runs it (ps -p <pid> -o pid,ppid,command; ListAgents),',
    'then acquire again, or pass --force to take the claim anyway.',
  ].join('\n');
}

/** Who to tell after a release, since a waiter that is not polling learns of its grant only at its next prompt. */
export function nextUp(next: Claim[]): string {
  if (next.length === 0) return '';
  const names = next.map((c) => `"${c.holder}"`).join(', ');
  return `\ngranted next: ${names} — tell them with SendMessage unless they sit in headroom wait or run.`;
}

export function granted(board: Board, c: Claim): string {
  const line = `granted #${c.id} — ${c.resource} ${c.mode} for ${formatLeft(c, Date.now())}. When done: headroom release ${c.id}`;
  if (c.yieldRequestedBy === null) return line;
  const seizer = board.get(c.yieldRequestedBy);
  return `${line}\nYIELD REQUESTED by ${seizer?.holder ?? 'another session'}${seizer ? `: ${seizer.why}` : ''}. Stop the work and release.`;
}

function ordinal(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

/** What a session is told when it is not granted: who to talk to, where it stands, and how to wait. */
export function queued(board: Board, claim: Claim): string {
  const now = Date.now();
  const { holding, waiting, notices } = board.status(claim.resource);
  const ahead = waiting.filter(
    (w) => w.id !== claim.id && (w.priority > claim.priority || w.createdAt < claim.createdAt),
  );
  const lines = [`waiting #${claim.id} — ${claim.resource} is not free; you are ${ordinal(ahead.length + 1)} in line.`];
  for (const n of notices) lines.push(`  notice from ${n.holder}: ${n.why}`);
  for (const h of holding) lines.push(`  held by ${h.holder} (${h.mode}, ${lifetime(h, now)}): ${h.why}`);
  for (const w of ahead) lines.push(`  ahead of you: ${w.holder} (${w.mode}): ${w.why}`);
  const names = [...holding, ...ahead].map((c) => `"${c.holder}"`).join(', ');
  if (names) lines.push(`To negotiate, use SendMessage with to: ${names}.`);
  lines.push(`To wait your turn: headroom wait ${claim.id} (blocks until it is yours, keeps the claim alive)`);
  return lines.join('\n');
}

/**
 * What the board looks like apart from the clock and the running shared claims,
 * which block nobody, so a session is shown it again only when something it could act on happened.
 */
export function signature(claims: Claim[]): string {
  return claims
    .filter((c) => !(c.mode === 'shared' && c.grantedAt !== null && c.acceptedAt !== null))
    .map((c) => `${c.id}:${c.grantedAt !== null}:${c.why}:${c.yieldRequestedBy ?? ''}`)
    .join('|');
}
