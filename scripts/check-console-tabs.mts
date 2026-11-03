/**
 * The console overlay's tabs, and stepping between them as Cmd+Shift+[ and ]
 * do. Run with `npm run check:console-tabs`.
 */

import { consoleTabs, stepConsole } from '../src/renderer/utils/console-tabs.ts';
import type { BifrostConfig } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

{
  const config = {
    machines: [
      { name: 'perf', host: 'perf', instance: true },
      { name: 'recipes', host: 'recipes' },
    ],
  } as BifrostConfig;
  const tabs = consoleTabs(config);
  check(
    'a console tab for this machine, then one per machine that runs its own instance',
    show(tabs) === show(['', 'perf']),
    show(tabs),
  );
}

{
  const tabs = ['', 'perf', 'gpu'];
  const steps = [stepConsole(tabs, '', -1), stepConsole(tabs, 'gpu', 1), stepConsole(tabs, '', 1)];
  check('stepping between consoles wraps at either end', show(steps) === show(['gpu', '', 'perf']), show(steps));
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
