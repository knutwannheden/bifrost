import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { Board } from './board.ts';

const MIN = 60_000;

/** A board on a fake clock and a fake process table, so expiry and crashes are values to set. */
function fresh() {
  let now = 1_000_000;
  const dead = new Set<number>();
  const board = Board.inMemory({ now: () => now, alive: (pid) => !dead.has(pid) });
  return { board, tick: (ms: number) => (now += ms), kill: (pid: number) => dead.add(pid) };
}

const cpu = (mode: 'shared' | 'exclusive', holder: string, extra: Partial<{ priority: number; ttlMs: number }> = {}) =>
  ({ resource: 'cpu', mode, holder, why: `${holder} work`, ttlMs: 10 * MIN, ...extra }) as const;

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
    board.claim(cpu('exclusive', 'bench', { ttlMs: 5 * MIN }));
    const next = board.claim(cpu('exclusive', 'next'));

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

  test('requeue releases the claim and files a fresh one at the back of the queue', () => {
    const { board } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench'));
    const other = board.claim(cpu('exclusive', 'other'));

    const { next, claim } = board.requeue(bench.id);
    expect(next.map((c) => c.id)).toEqual([other.id]);
    expect(claim.holder).toBe('bench');
    expect(claim.grantedAt).toBeNull();
    expect(board.get(bench.id)?.releasedAt).not.toBeNull();
  });

  test('renew extends a claim from now, not from its old expiry', () => {
    const { board, tick } = fresh();
    const bench = board.claim(cpu('exclusive', 'bench', { ttlMs: 5 * MIN }));
    tick(4 * MIN);
    const renewed = board.renew(bench.id, 10 * MIN);
    expect(renewed.expiresAt).toBe(1_000_000 + 4 * MIN + 10 * MIN);
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
