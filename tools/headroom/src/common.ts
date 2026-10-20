import os from 'node:os';
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

/**
 * The name other sessions message this one by, which Bifrost exports for its
 * sessions. A notice needs no address, so it may fall back to the user's name.
 */
export function holderName(as: string | undefined, kind: 'claim' | 'notice' = 'claim'): string {
  const name = as ?? process.env.HEADROOM_AS ?? process.env.BIFROST_SESSION_NAME;
  if (name) return name;
  if (kind === 'notice' && process.env.USER) return process.env.USER;
  throw new Error(
    'Pass --as <name>: the name other sessions message you by, which ListAgents shows as "This session is ...". ' +
      'Bifrost sessions get it from BIFROST_SESSION_NAME.',
  );
}

/** The machine's load right now, since a grant is advisory and does not make it quiet. */
export function load(): string {
  return `load ${os.loadavg()[0]!.toFixed(1)} on ${os.cpus().length} cores`;
}

/** Who to tell after a release, since a waiter that is not polling learns of its grant only at its next prompt. */
export function nextUp(next: Claim[]): string {
  if (next.length === 0) return '';
  const names = next.map((c) => `"${c.holder}"`).join(', ');
  return `\ngranted next: ${names} — tell them with SendMessage unless they sit in headroom wait or run.`;
}

export function granted(board: Board, c: Claim): string {
  const line = `granted #${c.id} — ${c.resource} ${c.mode} for ${formatLeft(c, Date.now())} (${load()}). When done: headroom release ${c.id}`;
  if (c.yieldRequestedBy === null) return line;
  const seizer = board.get(c.yieldRequestedBy);
  return `${line}\nYIELD REQUESTED by ${seizer?.holder ?? 'another session'}${seizer ? `: ${seizer.why}` : ''}. Stop the work and release.`;
}

/** What a session is told when it is not granted: who to talk to, and how to wait. */
export function queued(board: Board, claim: Claim): string {
  const now = Date.now();
  const { holding, waiting, notices } = board.status(claim.resource);
  const lines = [`waiting #${claim.id} — ${claim.resource} is not free.`];
  for (const n of notices) lines.push(`  notice from ${n.holder}: ${n.why}`);
  for (const h of holding) lines.push(`  held by ${h.holder} (${h.mode}, ${formatLeft(h, now)} left): ${h.why}`);
  const ahead = waiting.filter(
    (w) => w.id !== claim.id && (w.priority > claim.priority || w.createdAt < claim.createdAt),
  );
  for (const w of ahead) lines.push(`  ahead of you: ${w.holder} (${w.mode}): ${w.why}`);
  const names = [...holding, ...ahead].map((c) => `"${c.holder}"`).join(', ');
  if (names) lines.push(`To negotiate, use SendMessage with to: ${names}.`);
  lines.push(`To wait your turn: headroom wait ${claim.id} (blocks until granted, keeps the claim alive)`);
  return lines.join('\n');
}
