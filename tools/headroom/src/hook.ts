import type { Claim, Status } from './board.ts';
import { formatLeft } from './common.ts';

export interface HookOutput {
  /** One line for the user's terminal. */
  systemMessage: string;
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit' | 'SessionStart';
    /** The full picture for the model, which the banner only summarises. */
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

/**
 * The claims of each holder, in the order the holders first appear. A session
 * running two commands at once holds a claim for each.
 */
function byHolder(claims: Claim[], me: string | null): [string, Claim[]][] {
  const groups = new Map<string, Claim[]>();
  for (const c of claims) {
    const key = name(c, me);
    const group = groups.get(key);
    if (group) group.push(c);
    else groups.set(key, [c]);
  }
  return [...groups];
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
    if (started.length)
      parts.push(
        `held by ${byHolder(started, me)
          .map(([n, cs]) => {
            // The last of them to expire is when the holder could be done
            // with the resource.
            const until = cs.reduce((a, b) => (a.expiresAt >= b.expiresAt ? a : b));
            return `${n} (${cs[0].mode}${cs.length > 1 ? ` ×${cs.length}` : ''}, ${formatLeft(until, now)})`;
          })
          .join(', ')}`,
      );
    if (offered.length)
      parts.push(
        `offered to ${byHolder(offered, me)
          .map(([n, cs]) => `${n}${cs.length > 1 ? ` ×${cs.length}` : ''}`)
          .join(', ')}`,
      );
    if (waiting.length) parts.push(`${waiting.length} waiting`);
    banner.push(`${r}: ${parts.join('; ')}`);

    detail.push(`## ${r}`);
    for (const c of notices)
      detail.push(
        `- NOTICE #${c.id} from ${who(c, me)} (${formatLeft(c, now)} left), ` +
          `${c.holderLimit === 1 ? 'one claim at a time so claim and wait your turn' : 'nothing new is granted'}` +
          `: ${c.why}`,
      );
    for (const c of started) detail.push(`- held by ${who(c, me)}, ${c.mode}, ${formatLeft(c, now)} left: ${c.why}`);
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
