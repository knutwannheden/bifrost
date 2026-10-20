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
    board.claim({ resource: 'cpu', mode: 'exclusive', holder: 'bench', why: 'JMH on the parser', ttlMs: 7 * MIN });
    board.claim({ resource: 'cpu', mode: 'shared', holder: 'suite', why: 'full test run', ttlMs: 10 * MIN });

    const out = hookOutput(board.status(), null, T0);
    expect(out?.systemMessage).toMatch(/cpu.*bench.*exclusive.*7m/);
    expect(out?.systemMessage).not.toContain('JMH');
    const context = out?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toContain('JMH on the parser');
    expect(context).toMatch(/waiting.*suite/);
  });

  test("a session's own claim reads as you, not as its name", () => {
    const board = Board.inMemory({ now: () => T0 });
    board.claim({
      resource: 'cpu',
      mode: 'shared',
      holder: 'lock-regen',
      sessionId: 'sess-1',
      why: 'relocks',
      ttlMs: 10 * MIN,
    });
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
