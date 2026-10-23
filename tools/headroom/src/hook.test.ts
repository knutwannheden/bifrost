import { describe, expect, test } from 'vitest';
import { Board } from './board.ts';
import { hookOutput } from './hook.ts';

const MIN = 60_000;
const T0 = 1_000_000;

describe('hookOutput', () => {
  test('an empty board produces nothing to inject', () => {
    const board = Board.inMemory({ now: () => T0 });
    expect(hookOutput(board.status(), null, T0)).toBeNull();
  });

  test('holders and waiters reach the user as a banner and the model with the reasons', () => {
    const board = Board.inMemory({ now: () => T0 });
    const bench = board.claim({
      resource: 'cpu',
      mode: 'exclusive',
      holder: 'bench',
      why: 'JMH on the parser',
      ttlMs: 7 * MIN,
    });
    board.claim({ resource: 'cpu', mode: 'shared', holder: 'suite', why: 'full test run', ttlMs: 10 * MIN });
    board.attach(bench.id, process.pid);

    const out = hookOutput(board.status(), null, T0);
    expect(out?.systemMessage).toMatch(/cpu.*bench.*exclusive.*7m/);
    expect(out?.systemMessage).not.toContain('JMH');
    const context = out?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toContain('JMH on the parser');
    expect(context).toMatch(/waiting.*suite/);
  });

  test("a session's own claim reads as you, not as its name", () => {
    const board = Board.inMemory({ now: () => T0 });
    const mine = board.claim({
      resource: 'cpu',
      mode: 'shared',
      holder: 'lock-regen',
      sessionId: 'sess-1',
      why: 'relocks',
      ttlMs: 10 * MIN,
    });
    board.attach(mine.id, process.pid);
    board.claim({
      resource: 'cpu',
      mode: 'exclusive',
      holder: 'bench',
      sessionId: 'sess-2',
      why: 'JMH',
      ttlMs: 10 * MIN,
    });

    const out = hookOutput(board.status(), 'sess-1', T0);
    expect(out?.systemMessage).toMatch(/held by you \(shared/);
    expect(out?.systemMessage).not.toContain('lock-regen');
    const context = out?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toMatch(/held by you/);
    expect(context).toMatch(/waiting: bench/);
  });

  test('a session running two commands at once is named once with a count, not twice', () => {
    const board = Board.inMemory({ now: () => T0 });
    for (const [why, ttl] of [
      ['corpus replay', 10 * MIN],
      ['group-upgrade replay', 30 * MIN],
    ] as const) {
      const c = board.claim({
        resource: 'cpu',
        mode: 'shared',
        holder: 'resolver',
        sessionId: 'sess-1',
        why,
        ttlMs: ttl,
      });
      board.attach(c.id, process.pid);
    }

    const out = hookOutput(board.status(), 'sess-1', T0);
    expect(out?.systemMessage).toContain('held by you (shared ×2, 30m)');
    const context = out?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toContain('corpus replay');
    expect(context).toContain('group-upgrade replay');
  });

  test('a notice that only serializes work does not read as one that stops it', () => {
    const board = Board.inMemory({ now: () => T0 });
    board.claim({
      resource: 'cpu',
      mode: 'notice',
      holder: 'knut',
      why: 'on battery',
      ttlMs: 60 * MIN,
      holderLimit: 1,
    });

    const context = hookOutput(board.status(), null, T0)?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toMatch(/one claim at a time/);
    expect(context).not.toMatch(/nothing new is granted/);
  });

  test('an offer nobody has started reads as offered rather than held, and says how to take it', () => {
    const board = Board.inMemory({ now: () => T0 });
    board.claim({
      resource: 'cpu',
      mode: 'exclusive',
      holder: 'asleep',
      sessionId: 'sess-1',
      why: 'JMH on the parser',
      ttlMs: 10 * MIN,
    });

    const out = hookOutput(board.status(), 'sess-1', T0);
    expect(out?.systemMessage).toMatch(/offered to you/);
    expect(out?.hookSpecificOutput.additionalContext).toMatch(/not started yet.*headroom hold/);
  });

  test('a yield request against my own claim is spelled out with the release command', () => {
    const board = Board.inMemory({ now: () => T0 });
    const mine = board.claim({
      resource: 'cpu',
      mode: 'shared',
      holder: 'suite',
      sessionId: 'sess-1',
      why: 'full test run',
      ttlMs: 10 * MIN,
    });
    board.seize({ resource: 'cpu', holder: 'boss', why: 'hotfix timing', ttlMs: 5 * MIN });

    const context = hookOutput(board.status(), 'sess-1', T0)?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toMatch(/yield/i);
    expect(context).toContain('boss');
    expect(context).toContain(`headroom release ${mine.id}`);
  });
});
