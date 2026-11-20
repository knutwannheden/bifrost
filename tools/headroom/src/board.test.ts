import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Board, turnIn } from './board.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const GRACE = MIN;

/** A board on a fake clock and a fake process table, so expiry and crashes are values to set. */
function fresh() {
  let now = 1_000_000;
  const dead = new Set<number>();
  const board = Board.inMemory({ now: () => now, alive: (pid) => !dead.has(pid), offerGraceMs: GRACE });
  return { board, tick: (ms: number) => (now += ms), kill: (pid: number) => dead.add(pid) };
}

const cpu = (
  mode: 'shared' | 'exclusive',
  holder: string,
  extra: Partial<{ priority: number; ttlMs: number; expectMs: number }> = {},
) => ({ resource: 'cpu', mode, holder, why: `${holder} work`, ttlMs: 10 * MIN, ...extra }) as const;

describe('granting', () => {
  test('shared claims hold together, and a second resource is its own queue', () => {
    const { board } = fresh();
    const a = board.claim(cpu('shared', 'suite-a'));
    const b = board.claim(cpu('shared', 'suite-b'));
    const disk = board.claim({ ...cpu('exclusive', 'copier'), resource: 'disk' });

    expect(a.grantedAt).not.toBeNull();
    expect(b.grantedAt).not.toBeNull();
    expect(disk.grantedAt).not.toBeNull();
  });

  test('an exclusive claim waits for the holders to drain', () => {
    const { board } = fresh();
    const suite = board.claim(cpu('shared', 'suite'));
    const bench = board.claim(cpu('exclusive', 'bench'));
    expect(bench.grantedAt).toBeNull();

    board.release(suite.id);
    expect(board.get(bench.id)?.grantedAt).not.toBeNull();
  });

  test('a waiting exclusive claim stops later shared claims from slipping past it', () => {
    const { board } = fresh();
    const first = board.claim(cpu('shared', 'suite-1'));
    const bench = board.claim(cpu('exclusive', 'bench'));
    const second = board.claim(cpu('shared', 'suite-2'));
    expect(second.grantedAt).toBeNull();

    board.release(first.id);
    expect(board.get(bench.id)?.grantedAt).not.toBeNull();
    expect(board.get(second.id)?.grantedAt).toBeNull();

    board.release(bench.id);
    expect(board.get(second.id)?.grantedAt).not.toBeNull();
  });

  test('a higher priority goes ahead in the queue whatever its arrival order', () => {
    const { board } = fresh();
    const holder = board.claim(cpu('exclusive', 'holder'));
    const routine = board.claim(cpu('exclusive', 'routine'));
    const urgent = board.claim(cpu('exclusive', 'urgent', { priority: 5 }));

    board.release(holder.id);
    expect(board.get(urgent.id)?.grantedAt).not.toBeNull();
    expect(board.get(routine.id)?.grantedAt).toBeNull();
  });
});

describe('notices', () => {
  test('a notice blocks new grants but leaves current holders alone', () => {
    const { board } = fresh();
    const holder = board.claim(cpu('shared', 'suite'));
    const notice = board.claim({
      resource: 'cpu',
      mode: 'notice',
      holder: 'knut',
      why: 'generator power',
      ttlMs: 60 * MIN,
    });
    const late = board.claim(cpu('shared', 'late-suite'));

    expect(board.get(holder.id)?.grantedAt).not.toBeNull();
    expect(late.grantedAt).toBeNull();

    board.release(notice.id);
    expect(board.get(late.id)?.grantedAt).not.toBeNull();
  });
});

describe('lifetime', () => {
  test('an expired holder drops out and the next in line is granted', () => {
    const { board, tick } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench', { ttlMs: 5 * MIN }));
    const next = board.claim(cpu('exclusive', 'next'));
    // Started, so it is the ttl running out that frees the resource here and
    // not the offer grace.
    board.attach(bench.id, 4242);

    tick(5 * MIN + 1);
    expect(board.get(next.id)?.grantedAt).not.toBeNull();
  });

  test('a claim whose session process is gone is dropped before its ttl', () => {
    const { board, kill } = fresh();
    const crashed = board.claim({ ...cpu('exclusive', 'bench'), pid: 4242 });
    const next = board.claim(cpu('exclusive', 'next'));
    expect(board.get(next.id)?.grantedAt).toBeNull();

    kill(4242);
    expect(board.get(next.id)?.grantedAt).not.toBeNull();
    expect(board.get(crashed.id)?.releasedAt).not.toBeNull();
  });

  test('renew can restate the reason, so progress reaches the waiters through the board', () => {
    const { board } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench'));
    expect(board.renew(bench.id, 5 * MIN, 'round 3 of 5, ~10 min left').why).toBe('round 3 of 5, ~10 min left');
    expect(board.renew(bench.id, 5 * MIN).why).toBe('round 3 of 5, ~10 min left');
  });

  test('requeue lets the next in line run and files the claim again right behind it', () => {
    const { board, tick } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench'));
    const other = board.claim(cpu('exclusive', 'other'));
    tick(1);
    board.claim(cpu('exclusive', 'third'));

    const { next, claim } = board.requeue(bench.id);
    expect(next.map((c) => c.id)).toEqual([other.id]);
    expect(claim.holder).toBe('bench');
    expect(claim.grantedAt).toBeNull();
    expect(board.get(bench.id)?.releasedAt).not.toBeNull();
    expect(board.status('cpu').waiting.map((c) => c.holder)).toEqual(['bench', 'third']);
  });

  test('a started claim with no command holding it lets the next claim run, and waits its turn when it holds again', () => {
    const { board } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench'));
    board.attach(bench.id, 100);
    const other = board.claim(cpu('exclusive', 'other'));
    expect(other.grantedAt).not.toBeNull();
    board.attach(other.id, 200, true);

    board.attach(bench.id, 101, true);
    expect(board.get(bench.id)?.grantedAt).toBeNull();
    expect(board.status('cpu').waiting.map((c) => c.holder)).toEqual(['bench']);

    board.release(other.id);
    expect(board.get(bench.id)?.grantedAt).not.toBeNull();
  });

  test('a claim made with keep holds the resource while idle', () => {
    const { board } = fresh();
    const bench = board.claim({ ...cpu('exclusive', 'bench'), keep: true });
    board.attach(bench.id, 100);
    expect(board.claim(cpu('exclusive', 'other')).grantedAt).toBeNull();
  });

  test('renew extends a claim from now, not from its old expiry', () => {
    const { board, tick } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench', { ttlMs: 5 * MIN }));
    tick(4 * MIN);
    const renewed = board.renew(bench.id, 10 * MIN);
    expect(renewed.expiresAt).toBe(1_000_000 + 4 * MIN + 10 * MIN);
  });
});

describe('a notice that makes work take turns', () => {
  const serial = { resource: 'cpu', mode: 'notice', holder: 'knut', why: 'on battery', ttlMs: 60 * MIN } as const;

  test('shared claims stop holding together and run one at a time', () => {
    const { board } = fresh();
    board.claim({ ...serial, holderLimit: 1 });
    const first = board.claim(cpu('shared', 'suite-1'));
    const second = board.claim(cpu('shared', 'suite-2'));

    expect(first.grantedAt).not.toBeNull();
    expect(board.get(second.id)?.grantedAt).toBeNull();

    board.release(first.id);
    expect(board.get(second.id)?.grantedAt).not.toBeNull();
  });
});

describe('offers', () => {
  test('an offer nobody starts stops holding the queue back once the grace passes', () => {
    const { board, tick } = fresh();
    const asleep = board.claim(cpu('exclusive', 'asleep'));
    const awake = board.claim(cpu('exclusive', 'awake'));
    expect(asleep.grantedAt).not.toBeNull();
    expect(board.get(awake.id)?.grantedAt).toBeNull();

    tick(GRACE + 1);
    expect(board.get(awake.id)?.grantedAt).not.toBeNull();
  });

  test('whoever starts first keeps the resource, and the other offer goes back to the queue in place', () => {
    const { board, tick } = fresh();
    const asleep = board.claim(cpu('exclusive', 'asleep'));
    const awake = board.claim(cpu('exclusive', 'awake'));

    tick(GRACE + 1);
    board.attach(awake.id, 4242, true);

    expect(board.get(awake.id)?.grantedAt).not.toBeNull();
    expect(board.get(asleep.id)?.grantedAt).toBeNull();
    expect(board.get(asleep.id)?.releasedAt).toBeNull();
    expect(board.status('cpu').waiting.map((c) => c.holder)).toEqual(['asleep']);
  });

  test('renewing starts a claim nothing wraps, so the grace stops running against it', () => {
    const { board, tick } = fresh();
    const bare = board.claim({ ...cpu('exclusive', 'bare'), keep: true });
    const next = board.claim(cpu('exclusive', 'next'));
    board.renew(bare.id, 10 * MIN);

    tick(GRACE + 1);
    expect(board.get(next.id)?.grantedAt).toBeNull();
  });
});

describe('seize', () => {
  test('seize goes to the head of the queue, asks the holders to yield, and is granted when they go', () => {
    const { board } = fresh();
    const holder = board.claim(cpu('shared', 'suite'));
    board.claim(cpu('exclusive', 'waiting-bench', { priority: 5 }));

    const { claim, yielding } = board.seize({ resource: 'cpu', holder: 'boss', why: 'hotfix timing', ttlMs: 10 * MIN });
    expect(yielding.map((c) => c.holder)).toEqual(['suite']);
    expect(board.get(holder.id)?.yieldRequestedBy).toBe(claim.id);
    expect(claim.grantedAt).toBeNull();

    board.release(holder.id);
    expect(board.get(claim.id)?.grantedAt).not.toBeNull();
  });
});

describe('estimates', () => {
  test('a claim keeps the runtime its holder expects, and renew revises it', () => {
    const { board } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench', { expectMs: 17 * MIN }));
    expect(bench.expectMs).toBe(17 * MIN);
    expect(board.renew(bench.id, 5 * MIN, undefined, 25 * MIN).expectMs).toBe(25 * MIN);
    expect(board.renew(bench.id, 5 * MIN).expectMs).toBe(25 * MIN);
  });

  test("a waiting claim's turn comes once the claims ahead are expected to be done, shared ones together and an exclusive one alone", () => {
    const { board, tick } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench', { expectMs: 17 * MIN, ttlMs: HOUR }));
    board.attach(bench.id, 4242, true);
    board.claim(cpu('shared', 'suite-a', { expectMs: 3 * MIN, ttlMs: HOUR }));
    board.claim(cpu('shared', 'suite-b', { expectMs: 6 * MIN, ttlMs: HOUR }));
    board.claim(cpu('exclusive', 'profile', { expectMs: 2 * MIN, ttlMs: HOUR }));
    const me = board.claim(cpu('shared', 'me', { ttlMs: HOUR }));

    // bench ends at 5m from now, the suites together at 11m, then profile alone at 13m.
    expect(turnIn(board.status(), me.id, tick(12 * MIN))).toEqual({ ms: 13 * MIN });
  });

  test('a holder running past its estimate counts as about to finish', () => {
    const { board, tick } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench', { expectMs: 10 * MIN, ttlMs: HOUR }));
    board.attach(bench.id, 4242, true);
    const me = board.claim(cpu('shared', 'me', { ttlMs: HOUR }));

    expect(turnIn(board.status(), me.id, tick(15 * MIN))).toEqual({ ms: 0 });
  });

  test('a turn is unknown behind a claim with no estimate, and behind a notice that stops new work', () => {
    const { board, tick } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench'));
    const me = board.claim(cpu('shared', 'me'));
    const behindBench = turnIn(board.status(), me.id, tick(0));
    expect('unknown' in behindBench && behindBench.unknown.id).toBe(bench.id);

    board.release(bench.id);
    const notice = board.claim({ resource: 'cpu', mode: 'notice', holder: 'knut', why: 'on battery', ttlMs: HOUR });
    const later = board.claim(cpu('shared', 'later'));
    const behindNotice = turnIn(board.status(), later.id, tick(0));
    expect('unknown' in behindNotice && behindNotice.unknown.id).toBe(notice.id);
  });
});

describe('status', () => {
  test('status splits a resource into what holds, what waits and what is noticed', () => {
    const { board } = fresh();
    board.claim(cpu('shared', 'suite'));
    board.claim(cpu('exclusive', 'bench'));
    board.claim({ resource: 'cpu', mode: 'notice', holder: 'knut', why: 'heads up', ttlMs: 60 * MIN });

    const s = board.status('cpu');
    expect(s.holding.map((c) => c.holder)).toEqual(['suite']);
    expect(s.waiting.map((c) => c.holder)).toEqual(['bench']);
    expect(s.notices.map((c) => c.holder)).toEqual(['knut']);
  });
});

describe('persistence', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('a claim survives reopening the file', () => {
    dir = mkdtempSync(join(tmpdir(), 'headroom-'));
    const file = join(dir, 'board.db');
    const first = Board.open(file);
    const bench = first.claim(cpu('exclusive', 'bench'));
    first.close();

    const second = Board.open(file);
    expect(second.get(bench.id)?.holder).toBe('bench');
    second.close();
  });
});
