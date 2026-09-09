/**
 * A terminal acts for the session it shows: it writes to the clipboard, sizes
 * the child's grid, and decides how many cells a character occupies. Each is
 * unforgiving — a stray OSC 52 payload replaces what the user copied, a late
 * resize is time the child spends drawing against the wrong grid, and a narrow
 * emoji shifts every column after it. Run with `npm run check:terminal-io`.
 */
import headless from '@xterm/headless';
import { decodeOsc52 } from '../src/renderer/utils/osc52.ts';
import { createLeadingCoalescer } from '../src/renderer/utils/resize-scheduler.ts';
import { applyUnicodeWidths } from '../src/shared/terminal-unicode.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');

{
  const text = 'echo "héllo — wörld"';
  check(
    'a clipboard payload decodes as UTF-8, addressed or defaulted',
    decodeOsc52(`c;${encode(text)}`) === text && decodeOsc52(`;${encode(text)}`) === text,
  );

  // `p` is the X11 primary selection; this handler owns only the clipboard.
  const declined = [`c;?`, `p;${encode(text)}`, 'no-separator', 'c;not!base64'];
  const answered = declined.filter((payload) => decodeOsc52(payload) !== null);
  check(
    'a read request, a foreign selection and junk are all declined',
    answered.length === 0,
    `  answered: ${answered.join(', ')}`,
  );
}

{
  // The Unicode 15 grapheme provider leaves emoji at one cell, so swapping this
  // for the newer-sounding addon would quietly restore the misalignment.
  const term = new headless.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  applyUnicodeWidths(term);
  const cursorAfter = (text: string) =>
    new Promise<number>((r) => term.write(text, () => r(term.buffer.active.cursorX)));

  const emoji = await cursorAfter('🎉🎉🎉');
  await cursorAfter('\r\n');
  const boxDrawing = await cursorAfter('─│┌┐└┘');
  term.dispose();
  check(
    'emoji occupy two cells while box drawing stays narrow',
    emoji === 6 && boxDrawing === 6,
    `  emoji cursorX=${emoji} (want 6), box drawing cursorX=${boxDrawing} (want 6)`,
  );
}

{
  const runs: string[] = [];
  const coalescer = createLeadingCoalescer(() => runs.push('run'), 40);
  coalescer.request();
  const ranImmediately = runs.length === 1;
  await sleep(120);
  check(
    'a lone resize reaches the child at once and only once',
    ranImmediately && runs.length === 1,
    `  runs: ${runs.length}`,
  );
  coalescer.cancel();
}

{
  const runs: number[] = [];
  const coalescer = createLeadingCoalescer(() => runs.push(Date.now()), 40);
  const start = Date.now();
  // A drag: events every frame for ~100ms, then the pointer settles.
  for (let i = 0; i < 10; i++) {
    coalescer.request();
    await sleep(10);
  }
  await sleep(120);
  check(
    'a drag resizes at its leading edge and once more when it settles',
    runs.length === 2 && runs[0]! - start < 40 && runs[1]! - start >= 100,
    `  runs at +${runs.map((t) => t - start).join('ms, +')}ms`,
  );
  coalescer.cancel();
}

process.exit(failed === 0 ? 0 : 1);
