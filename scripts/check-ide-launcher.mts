/**
 * The editor command that opens a task's worktree or one of its files, here
 * or on the machine the task runs on. Run with `npm run check:ide-launcher`.
 */

import { ideCommand, remoteHost } from '../src/main/ide-launcher.ts';
import type { Machine, Task } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const task = (id: string, worktreePath: string, machine?: string) =>
  ({ id, worktreePath, ...(machine && { machine }) }) as Task;

{
  const tasks = [task('here', '/Users/u/git/r/.worktrees/a'), task('there', '/home/u/git/r/.worktrees/a', 'perf')];
  const machines: Machine[] = [{ name: 'perf', host: 'perf.example' }];
  const hosts = [
    remoteHost('/home/u/git/r/.worktrees/a/src/x.ts', tasks, machines),
    remoteHost('/home/u/git/r/.worktrees/a', tasks, machines),
    remoteHost('/home/u/git/r/.worktrees/ab/x.ts', tasks, machines),
    remoteHost('/Users/u/git/r/.worktrees/a/x.ts', tasks, machines),
  ];
  check(
    "a path in the worktree of a task on another machine names that machine's ssh host",
    show(hosts) === show(['perf.example', 'perf.example', null, null]),
    show(hosts),
  );
}

{
  const wt = '/home/u/git/r/.worktrees/a';
  const file = ideCommand('zed', wt, 'src/a b#1.ts', 12, 'perf.example');
  const folder = ideCommand('zed', wt, undefined, undefined, 'perf.example');
  check(
    'on another machine, Zed opens the file at its line, or else the worktree, through one ssh URL',
    show(file) === show({ command: 'zed', args: [`ssh://perf.example${wt}/src/a%20b%231.ts:12`] }) &&
      show(folder) === show({ command: 'zed', args: [`ssh://perf.example${wt}`] }),
    show({ file, folder }),
  );
}

{
  const wt = '/Users/u/git/r/.worktrees/a';
  const opened = ideCommand('zed', wt, 'src/x.ts', 12);
  check(
    'here, Zed opens the worktree with the file at its line',
    show(opened) === show({ command: 'zed', args: [wt, `${wt}/src/x.ts:12`] }),
    show(opened),
  );
}

{
  const refused = (['code', 'idea'] as const).map((ide) => {
    try {
      ideCommand(ide, '/home/u/wt', 'x.ts', 1, 'perf.example');
      return 'opened';
    } catch (err) {
      return (err as Error).message;
    }
  });
  check(
    'an editor other than Zed refuses a file on another machine',
    refused.every((m) => m.includes('Zed')),
    show(refused),
  );
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
