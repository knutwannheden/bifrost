/**
 * A terminal that joins a session mid-flight must end up showing exactly what a
 * terminal present from the start would show, at its own width. Run with
 * `npm run check:mirror`.
 */
import headless from '@xterm/headless';
import { createMirror, disposeMirror, mirrorOutput, snapshotMirror } from '../src/main/session-mirror.ts';

const { Terminal } = headless;
const ESC = String.fromCharCode(27);

const SPAWN_COLS = 120;
const ATTACH_COLS = 100;
const ROWS = 30;

const CHUNKS = [
  `${ESC}[1mBuilding${ESC}[0m the index\r\n`,
  `${'x'.repeat(110)} tail-past-100\r\n`,
  `${ESC}[31mrunning${ESC}[0m tests\r\n`,
  'line four\r\nline five\r\n',
];

/** What a terminal of this width displays after being written these chunks. */
async function display(cols: number, chunks: string[]): Promise<string> {
  const term = new Terminal({ cols, rows: ROWS, scrollback: 1000, allowProposedApi: true });
  for (const chunk of chunks) await new Promise<void>((r) => term.write(chunk, r));
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  term.dispose();
  return lines.join('\n').replace(/\s+$/, '');
}

/** The chunks a joining renderer writes: the snapshot, then everything after it. */
async function joinedChunks(id: string, before: string[], duringSnapshot: string[], after: string[]) {
  createMirror(id, SPAWN_COLS, ROWS);
  for (const chunk of before) mirrorOutput(id, chunk);

  const pending = snapshotMirror(id, ATTACH_COLS, ROWS);
  for (const chunk of duringSnapshot) mirrorOutput(id, chunk);
  const snapshot = await pending;
  if (!snapshot) throw new Error('no mirror');

  const chunks = [snapshot.replay, ...snapshot.held];
  for (const chunk of after) {
    if (mirrorOutput(id, chunk)) chunks.push(chunk);
  }
  disposeMirror(id);
  return chunks;
}

const cases: [string, string[], string[], string[]][] = [
  ['everything before the attach', CHUNKS, [], []],
  ['output arriving mid-snapshot', CHUNKS.slice(0, 3), CHUNKS.slice(3), []],
  ['output continuing after the attach', CHUNKS.slice(0, 2), [], CHUNKS.slice(2)],
  ['output on both sides of the snapshot', CHUNKS.slice(0, 2), CHUNKS.slice(2, 3), CHUNKS.slice(3)],
];

const expected = await display(ATTACH_COLS, CHUNKS);
let failed = 0;
for (const [name, before, during, after] of cases) {
  const actual = await display(ATTACH_COLS, await joinedChunks(name, before, during, after));
  if (actual === expected) {
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}\n--- got ---\n${actual}\n--- want ---\n${expected}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
