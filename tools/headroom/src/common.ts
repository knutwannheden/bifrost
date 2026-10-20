import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { basename } from 'node:path';
import type { Board, Claim } from './board.ts';

export function formatLeft(claim: Claim, now: number): string {
  const ms = claim.expiresAt - now;
  if (ms <= 0) return 'expiring';
  const min = Math.ceil(ms / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? `${min % 60}m` : ''}` : `${min}m`;
}

export function parseDuration(text: string): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec(text.trim());
  if (!m) throw new Error(`Bad duration "${text}" — use 90s, 10m, 1h`);
  return Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, '': 60_000 }[m[2]]!;
}

/** The Claude Code session this process serves, which every Bash call is told and an MCP server is a child of. */
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
 */
export async function holderName(as: string | undefined, kind: 'claim' | 'notice' = 'claim'): Promise<string> {
  const name = as ?? process.env.HEADROOM_AS ?? process.env.BIFROST_SESSION_NAME ?? (await bifrostSessionName());
  if (name) return name;
  if (kind === 'notice' && process.env.USER) return process.env.USER;
  throw new Error(
    'Pass --as <name>: the name other sessions message you by, which ListAgents shows as "This session is ...".',
  );
}

export type NameResolver = (as: string | undefined, kind?: 'claim' | 'notice') => string | Promise<string>;

/**
 * How busy the machine is over one second, and the heaviest processes that
 * belong to no claim. A grant is advisory, so this is what says whether it
 * bought quiet.
 */
export async function quiet(holderPids: number[]): Promise<string> {
  const before = os.cpus().map((c) => c.times);
  await new Promise((r) => setTimeout(r, 1000));
  const after = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  after.forEach((t, i) => {
    const b = before[i]!;
    idle += t.idle - b.idle;
    total += t.user - b.user + (t.nice - b.nice) + (t.sys - b.sys) + (t.idle - b.idle) + (t.irq - b.irq);
  });
  const busy = total > 0 ? Math.round(100 * (1 - idle / total)) : 0;

  const ps = spawnSync('ps', ['-Ao', 'pid,ppid,pcpu,comm'], { encoding: 'utf8' }).stdout ?? '';
  const rows = ps
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((f) => f.length >= 4)
    .map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), cpu: Number(f[2]), comm: basename(f.slice(3).join(' ')) }));
  const parent = new Map(rows.map((r) => [r.pid, r.ppid]));
  const holders = new Set(holderPids);
  const underClaim = (pid: number): boolean => {
    for (let p: number | undefined = pid; p && p > 1; p = parent.get(p)) if (holders.has(p)) return true;
    return false;
  };
  const top = rows
    .filter((r) => r.cpu >= 5 && !underClaim(r.pid))
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, 3)
    .map((r) => `${r.comm} ${Math.round(r.cpu)}%`);
  return `${busy}% busy${top.length ? `; outside any claim: ${top.join(', ')}` : ''}`;
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
  for (const h of holding) lines.push(`  held by ${h.holder} (${h.mode}, ${formatLeft(h, now)} left): ${h.why}`);
  for (const w of ahead) lines.push(`  ahead of you: ${w.holder} (${w.mode}): ${w.why}`);
  const names = [...holding, ...ahead].map((c) => `"${c.holder}"`).join(', ');
  if (names) lines.push(`To negotiate, use SendMessage with to: ${names}.`);
  lines.push(`To wait your turn: headroom wait ${claim.id} (blocks until it is yours, keeps the claim alive)`);
  return lines.join('\n');
}

/** What the board looks like apart from the clock, so a session is shown it again only when something happened. */
export function signature(claims: Claim[]): string {
  return claims.map((c) => `${c.id}:${c.grantedAt !== null}:${c.why}:${c.yieldRequestedBy ?? ''}`).join('|');
}
