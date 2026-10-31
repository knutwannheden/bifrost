import { describe, expect, test } from 'vitest';
import { foreignLoad, parsePs, sampleForeignLoad } from './machine.ts';

const table = (rows: string[]) => parsePs(['  PID  PPID      TIME COMMAND', ...rows].join('\n'));

describe('foreignLoad', () => {
  test('counts and names the processes outside every claim that burn at least half a core each', () => {
    const before = table([
      '100 1 0:10.00 gradle',
      '200 100 0:00.00 java',
      '300 1 0:05.00 python',
      '400 1 1:00.00 WindowServer',
      '500 1 0:00.00 claude',
    ]);
    const after = table([
      '100 1 0:11.50 gradle',
      '200 100 0:00.00 java',
      '300 1 0:05.50 python',
      '400 1 1:00.40 WindowServer',
      '500 1 0:00.45 claude',
    ]);

    const load = foreignLoad(before, after, 1000, []);
    expect(load.percent).toBe(200);
    expect(load.top.map((p) => p.pid)).toEqual([100, 300]);
    expect(load.top[0]).toMatchObject({ pid: 100, comm: 'gradle', percent: 150 });
  });

  test('a process under a holder or under the asker is not foreign', () => {
    const before = table([
      '100 1 0:10.00 gradle',
      '200 100 0:00.00 java',
      '300 1 0:05.00 python',
      '500 1 0:00.00 claude',
    ]);
    const after = table([
      '100 1 0:10.00 gradle',
      '200 100 0:02.00 java',
      '300 1 0:07.00 python',
      '500 1 0:00.00 claude',
    ]);

    expect(foreignLoad(before, after, 1000, [100]).percent).toBe(200);
    expect(foreignLoad(before, after, 1000, [100, 300]).percent).toBe(0);
  });
});

test('a machine that cannot be sampled says why instead of looking quiet', async () => {
  process.env.HEADROOM_PS = '/nonexistent/ps';
  process.env.HEADROOM_SAMPLE_MS = '1';
  const load = await sampleForeignLoad([]);
  expect(load).toHaveProperty('error');
  expect((load as { error: string }).error).toMatch(/ENOENT/);
});
