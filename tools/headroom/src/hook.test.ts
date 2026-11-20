import { describe, expect, test } from 'vitest';
import { Board } from './board.ts';
import { hookOutput } from './hook.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
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
    board.attach(bench.id, process.pid, true);

    const out = hookOutput(board.status(), null, T0);
    expect(out?.systemMessage).toContain('cpu: held by bench (exclusive)');
    expect(out?.systemMessage).not.toMatch(/JMH|7m/);
    const context = out?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toContain('JMH on the parser');
    expect(context).toMatch(/waiting.*suite/);
  });

  test('a claim held around a command shows no countdown, since the command renews it', () => {
    const board = Board.inMemory({ now: () => T0 });
    const bench = board.claim({ resource: 'cpu', mode: 'exclusive', holder: 'bench', why: 'JMH', ttlMs: 10 * MIN });
    board.attach(bench.id, process.pid, true);

    const context = hookOutput(board.status(), null, T0)?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toContain('held by bench, exclusive, <1m in, renewed while its command runs: JMH');
    expect(context).not.toMatch(/\dm left/);
  });

  test('a held claim says how long it has held, against its estimate when it gave one', () => {
    let now = T0;
    const board = Board.inMemory({ now: () => now });
    const bench = board.claim({
      resource: 'cpu',
      mode: 'exclusive',
      holder: 'bench',
      why: 'JMH',
      ttlMs: HOUR,
      expectMs: 17 * MIN,
    });
    const copier = board.claim({ resource: 'disk', mode: 'exclusive', holder: 'copier', why: 'copy', ttlMs: HOUR });
    board.attach(bench.id, process.pid, true);
    board.attach(copier.id, process.pid, true);
    const context = () => hookOutput(board.status(), null, now)?.hookSpecificOutput.additionalContext ?? '';

    now += 12 * MIN;
    expect(context()).toContain('held by bench, exclusive, 12m of ~17m, renewed while its command runs: JMH');
    expect(context()).toContain('held by copier, exclusive, 12m in, renewed while its command runs: copy');

    now += 9 * MIN;
    expect(context()).toContain(
      'held by bench, exclusive, 21m of ~17m, over its estimate, renewed while its command runs',
    );
  });

  test('a waiting session is told when its turn comes, in the banner and on the board', () => {
    let now = T0;
    const board = Board.inMemory({ now: () => now });
    const bench = board.claim({
      resource: 'cpu',
      mode: 'exclusive',
      holder: 'bench',
      why: 'JMH',
      ttlMs: HOUR,
      expectMs: 17 * MIN,
    });
    board.attach(bench.id, process.pid, true);
    board.claim({ resource: 'cpu', mode: 'shared', holder: 'suite', sessionId: 's-me', why: 'tests', ttlMs: HOUR });

    now += 12 * MIN;
    const out = hookOutput(board.status(), 's-me', now);
    expect(out?.systemMessage).toContain('1 waiting; your turn in about 5m');
    expect(out?.hookSpecificOutput.additionalContext).toContain(
      'waiting: you, shared, priority 0, turn in about 5m: tests',
    );
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
    board.attach(mine.id, process.pid, true);
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
    expect(out?.systemMessage).toContain('held by you (shared ×2)');
    const context = out?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toContain('corpus replay');
    expect(context).toContain('group-upgrade replay');
  });

  test("other sessions' shared claims are counted by session, while my own stay named", () => {
    const board = Board.inMemory({ now: () => T0 });
    for (const [holder, sessionId, why] of [
      ['lock-regen', 'sess-1', 'relocks'],
      ['runner', 'sess-2', 'unit tests'],
      ['runner', 'sess-2', 'integration tests'],
      ['runner', 'sess-3', 'lint'],
    ] as const) {
      const c = board.claim({ resource: 'cpu', mode: 'shared', holder, sessionId, why, ttlMs: 10 * MIN });
      board.attach(c.id, process.pid);
    }

    const out = hookOutput(board.status(), 'sess-1', T0);
    expect(out?.systemMessage).toBe('headroom — cpu: held by you (shared); 3 shared claims from 2 sessions');
    const context = out?.hookSpecificOutput.additionalContext ?? '';
    expect(context).toContain('relocks');
    expect(context).not.toMatch(/runner|unit tests/);
    expect(context).toContain('3 shared claims from 2 other sessions; `headroom status` lists them');
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
