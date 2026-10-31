import type { Claim, Status } from './board.ts';
import { formatLeft, lifetime } from './common.ts';

export interface HookOutput {
  /** One line for the user's terminal. */
  systemMessage: string;
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit' | 'SessionStart' | 'PostToolUse';
    /** What the model needs from the board, with the reasons the banner leaves out. */
    additionalContext: string;
  };
}

/** The holder as the reading session knows it: itself as "you", anyone else by name and session id. */
function who(c: Claim, me: string | null): string {
  if (me && c.sessionId === me) return 'you';
  return c.sessionId ? `${c.holder} [${c.sessionId}]` : c.holder;
}

function name(c: Claim, me: string | null): string {
  return me && c.sessionId === me ? 'you' : c.holder;
}

/** The session a claim belongs to. Sessions can share a holder name, so the name alone cannot tell them apart. */
function sessionOf(c: Claim): string {
  return c.sessionId ?? c.holder;
}

/**
 * The claims of each session, in the order the sessions first appear. A
 * session running two commands at once holds a claim for each.
 */
function bySession(claims: Claim[]): Claim[][] {
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    const group = groups.get(sessionOf(c));
    if (group) group.push(c);
    else groups.set(sessionOf(c), [c]);
  }
  return [...groups.values()];
}

/** Each session once, with a count when it holds more than one claim. */
function named(claims: Claim[], me: string | null, withMode: boolean): string {
  return bySession(claims)
    .map((cs) => {
      const times = cs.length > 1 ? ` ×${cs.length}` : '';
      return withMode ? `${name(cs[0], me)} (${cs[0].mode}${times})` : `${name(cs[0], me)}${times}`;
    })
    .join(', ');
}

function sharedCount(claims: Claim[], sessions: string): string {
  const n = claims.length;
  const s = new Set(claims.map(sessionOf)).size;
  return `${n} shared claim${n === 1 ? '' : 's'} from ${s} ${sessions}${s === 1 ? '' : 's'}`;
}

/** What the board says to a session about to act, or null when it has nothing to say. */
export function hookOutput(
  status: Status,
  me: string | null,
  now: number,
  event: HookOutput['hookSpecificOutput']['hookEventName'] = 'UserPromptSubmit',
): HookOutput | null {
  const all = [...status.notices, ...status.holding, ...status.waiting];
  if (all.length === 0) return null;

  const resources = [...new Set(all.map((c) => c.resource))];
  const banner: string[] = [];
  const detail: string[] = [];

  for (const r of resources) {
    const notices = status.notices.filter((c) => c.resource === r);
    const holding = status.holding.filter((c) => c.resource === r);
    const waiting = status.waiting.filter((c) => c.resource === r);

    const parts: string[] = [];
    if (notices.length)
      parts.push(
        `notice from ${notices.map((c) => `${name(c, me)}${c.holderLimit === 1 ? ' (one at a time)' : ''}`).join(', ')}`,
      );
    const started = holding.filter((c) => c.acceptedAt !== null);
    const offered = holding.filter((c) => c.acceptedAt === null);
    // Another session's shared claim blocks no one, so it is only counted. A claim that can block is named.
    const counted = started.filter((c) => c.mode === 'shared' && !(me && c.sessionId === me));
    const shown = started.filter((c) => !counted.includes(c));
    if (shown.length) parts.push(`held by ${named(shown, me, true)}`);
    if (counted.length) parts.push(sharedCount(counted, 'session'));
    if (offered.length) parts.push(`offered to ${named(offered, me, false)}`);
    if (waiting.length) parts.push(`${waiting.length} waiting`);
    banner.push(`${r}: ${parts.join('; ')}`);

    detail.push(`## ${r}`);
    for (const c of notices)
      detail.push(
        `- NOTICE #${c.id} from ${who(c, me)} (${formatLeft(c, now)} left), ` +
          `${c.holderLimit === 1 ? 'one claim at a time so claim and wait your turn' : 'nothing new is granted'}` +
          `: ${c.why}`,
      );
    for (const c of shown) detail.push(`- held by ${who(c, me)}, ${c.mode}, ${lifetime(c, now)}: ${c.why}`);
    if (counted.length) detail.push(`- ${sharedCount(counted, 'other session')}; \`headroom status\` lists them`);
    for (const c of offered)
      detail.push(
        `- offered to ${who(c, me)}, ${c.mode}, not started yet — take it with \`headroom hold ${c.id}\` ` +
          `or lose it to whoever is ready: ${c.why}`,
      );
    for (const c of waiting) detail.push(`- waiting: ${who(c, me)}, ${c.mode}, priority ${c.priority}: ${c.why}`);
  }

  const yields = me ? status.holding.filter((c) => c.sessionId === me && c.yieldRequestedBy !== null) : [];
  for (const c of yields) {
    const seizer = status.waiting.find((w) => w.id === c.yieldRequestedBy);
    detail.unshift(
      `YIELD REQUESTED on ${c.resource}: ${seizer ? who(seizer, me) : 'another session'} needs it now` +
        `${seizer ? ` — ${seizer.why}` : ''}. Stop your work there and run \`headroom release ${c.id}\`.`,
    );
  }

  return {
    systemMessage: `headroom — ${banner.join(' · ')}`,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: [
        'Shared resources on this machine (from `headroom status`):',
        ...detail,
        'Before CPU-heavy work (benchmarks, profiling, full builds, long suites), claim with `headroom acquire`.',
      ].join('\n'),
    },
  };
}

/** What a holder is told after a tool call about sessions that started waiting behind its claim. */
export function waitingBehind(held: Claim, waiters: Claim[]): HookOutput {
  const names = waiters.map((w) => w.holder).join(', ');
  return {
    systemMessage: `headroom — ${names} waiting on ${held.resource} behind your claim #${held.id}`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: [
        ...waiters.map(
          (w) =>
            `${w.holder} [${w.sessionId ?? '-'}] is waiting on ${held.resource} behind your claim #${held.id}: ${w.why}`,
        ),
        `If nothing runs under #${held.id} now, step aside with \`headroom release ${held.id} --requeue\`.`,
        'The next in line runs while you prepare your next step, and your claim comes back right behind it.',
        `If you are finished with ${held.resource}, \`headroom release ${held.id}\` instead.`,
      ].join('\n'),
    },
  };
}
