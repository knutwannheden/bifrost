/**
 * A shell-written change reaches the feed as one card per run of edits to a
 * file, measured from where that card began. Run with
 * `npm run check:worktree-scan`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initChangeFeed, loadChangeFeed, pollChangeFeed, setActiveFeedTask } from '../src/main/change-feed-service.ts';
import type { FeedChange, FeedItem } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-scan-'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '.');
git('config', 'user.email', 'check@example.com');
git('config', 'user.name', 'check');
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
fs.writeFileSync(path.join(repo, 'b.txt'), 'x\n');
git('add', '-A');
git('commit', '-qm', 'init');

let items: FeedItem[] = [];
const sink = { webContents: { send: (_c: string, _t: string, next: FeedItem[]) => (items = next) } };
// The service only needs somewhere to send to; a window is more than that.
initChangeFeed(sink as unknown as Parameters<typeof initChangeFeed>[0]);
setActiveFeedTask('t');
loadChangeFeed('t', repo, undefined);

/** A tool call is recorded before a scan sees what it did, so it reads as past. */
const bashLine = (id: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(Date.now() - 1000).toISOString(),
    uuid: `${id}-u`,
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: "sed -i '' s/x/y/ f" } }] },
  });

const shape = (cards: FeedChange[]) =>
  cards.map((c) => `${c.relPath}x${c.editCount}+${c.added}-${c.removed}`).join(' ');

let call = 0;

const cards = () => items.filter((i): i is FeedChange => i.kind === 'change');

/**
 * Drive one round and wait for the scan behind it. A poll reports the
 * transcript at once and the worktree only after git has walked it, so the wait
 * is for the cards to move rather than for anything at all to arrive.
 */
async function scan(write?: () => void, ticks = 80): Promise<FeedChange[]> {
  write?.();
  call++;
  const before = shape(cards());
  pollChangeFeed('t', repo, [bashLine(`b${call}`)], undefined, sink as never);
  for (let i = 0; i < ticks && shape(cards()) === before; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return cards();
}

/** A round expected to draw nothing still has to outlast git walking the tree. */
const QUIET_TICKS = 20;

const write = (name: string, body: string) => () => fs.writeFileSync(path.join(repo, name), body);
const looseObjects = () =>
  Number(/^count: (\d+)$/m.exec(execFileSync('git', ['count-objects', '-v'], { cwd: repo }).toString())?.[1] ?? -1);

const objectsAtStart = looseObjects();

await scan(undefined, QUIET_TICKS);
check('the worktree as first found is the ground, not a change', (await scan(undefined, QUIET_TICKS)).length === 0);

const first = await scan(write('a.txt', 'ONE\ntwo\nthree\n'));
check('a shell-written change becomes a card', shape(first) === 'a.txtx1+1-1', `  ${shape(first)}`);

// The reported defect: a second edit replaced the first rather than joining it.
const second = await scan(write('a.txt', 'ONE\nTWO\nthree\n'));
check(
  'a further edit to the same file joins the card it is already in',
  shape(second) === 'a.txtx2+2-2',
  `  ${shape(second)}`,
);

const other = await scan(write('b.txt', 'y\n'));
check('another file starts its own card', shape(other) === 'a.txtx2+2-2 b.txtx1+1-1', `  ${shape(other)}`);

const third = await scan(write('a.txt', 'ONE\nTWO\nTHREE\n'));
check(
  'returning to a file after another opens a card holding only what is new',
  shape(third) === 'a.txtx2+2-2 b.txtx1+1-1 a.txtx1+1-1',
  `  ${shape(third)}`,
);

// A snapshot writes a blob and a tree per directory. In the repository those
// would be unreachable, and `gc` keeps unreachable objects for two weeks.
check(
  'snapshots leave nothing behind in the repository',
  looseObjects() === objectsAtStart,
  `  ${objectsAtStart} -> ${looseObjects()} loose objects`,
);

fs.rmSync(repo, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
