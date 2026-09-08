/**
 * Arrow keys walk a task list longer than the panel renders, so the window has
 * to stay ahead of the focus. Run with `npm run check:paging`.
 */
import { PAGE_SIZE, visibleCountFor } from '../src/renderer/utils/paging.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

{
  const total = 1000;
  let count = PAGE_SIZE;
  let lostFocusAt = -1;

  for (let focusedIdx = 0; focusedIdx < total; focusedIdx++) {
    count = visibleCountFor(focusedIdx, count, total);
    if (focusedIdx >= count && lostFocusAt < 0) lostFocusAt = focusedIdx;
  }

  check('arrowing to the end keeps the focused row rendered', lostFocusAt < 0, `  lost focus at row ${lostFocusAt}`);
}

// Scrolling grows the window past what focus needs; focus must not claw it back.
check('a window grown by scrolling survives a keystroke', visibleCountFor(99, 400, 1000) === 400);

process.exit(failed === 0 ? 0 : 1);
