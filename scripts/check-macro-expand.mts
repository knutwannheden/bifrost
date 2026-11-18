/**
 * ⌥Space puts, press by press, the text of each macro whose name starts with the
 * name that ends at the cursor, then that name again. Run with
 * `npm run check:macro-expand`.
 */
import headless from '@xterm/headless';
import { nextExpansion, resetMacroCycle } from '../src/renderer/utils/macro-expand.ts';
import type { Macro } from '../src/shared/types.ts';

const { Terminal } = headless;

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}
const show = (value: unknown) => JSON.stringify(value);

const macros: Macro[] = [
  { name: 'crhf', text: '/code-review high --fix' },
  { name: 'crmf', text: '/code-review medium --fix' },
  { name: 'crh', text: '/code-review high' },
  { name: 'han-do', text: '/handoff' },
];

/** A terminal this is written to, with the cursor where the writing ends. */
async function terminal(written: string) {
  const term = new Terminal({ cols: 80, rows: 5, allowProposedApi: true });
  await new Promise<void>((r) => term.write(written, r));
  return term;
}

let sessions = 0;
/** What successive presses put in place, in a terminal of their own. */
async function presses(written: string, count: number) {
  const term = await terminal(written);
  const sessionId = `s${++sessions}`;
  return Array.from({ length: count }, () => nextExpansion(term, sessionId, macros));
}

{
  const several = await presses('❯ please cr', 5);
  const one = await presses('❯ han', 3);
  check(
    'presses cycle through the macros a start names, then back to what was typed, even when one name has it',
    show(several) ===
      show([
        { erase: 2, text: '/code-review high --fix' },
        { erase: 23, text: '/code-review medium --fix' },
        { erase: 25, text: '/code-review high' },
        { erase: 17, text: 'cr' },
        { erase: 2, text: '/code-review high --fix' },
      ]) &&
      show(one) ===
        show([
          { erase: 3, text: '/handoff' },
          { erase: 8, text: 'han' },
          { erase: 3, text: '/handoff' },
        ]),
    show({ several, one }),
  );
}

{
  const nested = await presses('❯ crh', 2);
  check(
    'a full name comes before the longer names it starts',
    show(nested) ===
      show([
        { erase: 3, text: '/code-review high' },
        { erase: 17, text: '/code-review high --fix' },
      ]),
    show(nested),
  );
}

{
  const [dashed] = await presses('❯ han-d', 1);
  const [afterSpace] = await presses('❯ crhf ', 1);
  check(
    'the name runs back from the cursor to a space, through characters like "-"',
    show(dashed) === show({ erase: 5, text: '/handoff' }) && afterSpace === null,
    show({ dashed, afterSpace }),
  );
}

{
  const [cr, han] = [await terminal('❯ cr'), await terminal('❯ han')];
  resetMacroCycle();
  nextExpansion(cr, 'a', macros);
  const elsewhere = nextExpansion(han, 'b', macros);
  nextExpansion(cr, 'c', macros);
  resetMacroCycle();
  const afterInput = nextExpansion(han, 'c', macros);
  const fresh = show({ erase: 3, text: '/handoff' });
  check(
    'a cycle starts over after other input, and in another terminal',
    show(afterInput) === fresh && show(elsewhere) === fresh,
    show({ afterInput, elsewhere }),
  );
}

process.exit(failed === 0 ? 0 : 1);
