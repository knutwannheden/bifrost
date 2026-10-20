import type { Claim, Status } from './board.ts';
import { formatLeft, load } from './common.ts';

export interface HookOutput {
  /** One line for the user's terminal. */
  systemMessage: string;
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit' | 'SessionStart';
    /** The full picture for the model, which the banner only summarises. */
    additionalContext: string;
  };
}

function who(c: Claim): string {
  return c.sessionId ? `${c.holder} [${c.sessionId}]` : c.holder;
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
    if (notices.length) parts.push(`notice from ${notices.map((c) => c.holder).join(', ')}`);
    if (holding.length)
      parts.push(`held by ${holding.map((c) => `${c.holder} (${c.mode}, ${formatLeft(c, now)})`).join(', ')}`);
    if (waiting.length) parts.push(`${waiting.length} waiting`);
    banner.push(`${r}: ${parts.join('; ')}`);

    detail.push(`## ${r}`);
    for (const c of notices) detail.push(`- NOTICE from ${who(c)} (${formatLeft(c, now)} left): ${c.why}`);
    for (const c of holding) detail.push(`- held by ${who(c)}, ${c.mode}, ${formatLeft(c, now)} left: ${c.why}`);
    for (const c of waiting) detail.push(`- waiting: ${who(c)}, ${c.mode}, priority ${c.priority}: ${c.why}`);
  }

  const yields = me ? status.holding.filter((c) => c.sessionId === me && c.yieldRequestedBy !== null) : [];
  for (const c of yields) {
    const seizer = status.waiting.find((w) => w.id === c.yieldRequestedBy);
    detail.unshift(
      `YIELD REQUESTED on ${c.resource}: ${seizer ? who(seizer) : 'another session'} needs it now` +
        `${seizer ? ` — ${seizer.why}` : ''}. Stop your work there and run \`headroom release ${c.id}\`.`,
    );
  }

  return {
    systemMessage: `headroom — ${banner.join(' · ')}`,
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: [
        `Shared resources on this machine (from \`headroom status\`, ${load()}):`,
        ...detail,
        'Before CPU-heavy work (benchmarks, profiling, full builds, long suites), claim with `headroom acquire`.',
      ].join('\n'),
    },
  };
}
