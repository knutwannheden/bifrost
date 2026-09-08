/**
 * The change feed folds a transcript into narration, merged per-file diffs, and
 * ticks. Run with `npm run check:change-feed`.
 */
import {
  blobSha,
  changeEventsOnly,
  commandLabel,
  DEFAULT_IGNORE,
  type FeedEvent,
  foldFeed,
  isIgnored,
  movesTreeWholesale,
  parseDiffTree,
  parseFeedLines,
} from '../src/main/change-feed.ts';
import { messageTargetName } from '../src/renderer/utils/agent-address.ts';
import type { FeedChange, FeedItem, FeedTick } from '../src/shared/types.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}`);
  if (!ok && detail) console.log(detail);
}

const WORKTREE = '/w';
let clock = 0;
function at(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

const thought = (t: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(),
    message: { content: [{ type: 'thinking', thinking: t, signature: 'sig' }] },
  });

const text = (t: string) =>
  JSON.stringify({ type: 'assistant', timestamp: at(), message: { content: [{ type: 'text', text: t }] } });

const call = (id: string, name: string, input: Record<string, unknown>) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at(),
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });

const result = (id: string, toolUseResult: Record<string, unknown>) =>
  JSON.stringify({
    type: 'user',
    timestamp: at(),
    message: { content: [{ type: 'tool_result', tool_use_id: id }] },
    toolUseResult,
  });

/** An Edit tool call and its result, as the transcript records the pair. */
function edit(id: string, file: string, originalFile: string, oldString: string, newString: string): string[] {
  return [
    call(id, 'Edit', { file_path: `${WORKTREE}/${file}`, old_string: oldString, new_string: newString }),
    result(id, { filePath: `${WORKTREE}/${file}`, originalFile, oldString, newString, structuredPatch: [] }),
  ];
}

/** A Write, shaped as the transcript records it: a create reports no originalFile. */
function write(id: string, file: string, originalFile: string | null, content: string, type: 'create' | 'update') {
  const r: Record<string, unknown> = { filePath: `${WORKTREE}/${file}`, content, type, structuredPatch: [] };
  if (originalFile !== null) r.originalFile = originalFile;
  return [call(id, 'Write', { file_path: `${WORKTREE}/${file}`, content }), result(id, r)];
}

function fold(lines: string[]): FeedItem[] {
  return foldFeed(parseFeedLines(lines), { taskId: 't', worktreePath: WORKTREE });
}

const changes = (items: FeedItem[]) => items.filter((i): i is FeedChange => i.kind === 'change');
const ticks = (items: FeedItem[]) => items.filter((i): i is FeedTick => i.kind === 'tick');
const body = (c: FeedChange) => c.hunks.flatMap((h) => h.lines).join('\n');

{
  const items = fold([
    ...edit('1', 'a.ts', 'a\n', 'a', 'A'),
    ...edit('2', 'b.ts', 'b\n', 'b', 'B'),
    ...edit('3', 'a.ts', 'A\n', 'A', 'AA'),
  ]);
  const c = changes(items);
  check(
    'an edit to a different file breaks the group',
    c.length === 3,
    `  got ${c.length} cards: ${c.map((x) => `${x.relPath}x${x.editCount}`).join(', ')}`,
  );
}

{
  const items = fold([
    ...edit('1', 'a.ts', 'one\ntwo\n', 'one', 'ONE'),
    text('Now the second line.'),
    ...edit('2', 'a.ts', 'ONE\ntwo\n', 'two', 'TWO'),
  ]);
  const c = changes(items);
  check(
    'narration between two edits to one file breaks the group',
    c.length === 2 && items[1].kind === 'narration',
    `  got ${items.map((i) => i.kind).join(', ')}`,
  );
}

{
  const items = fold([
    ...edit('1', 'a.ts', 'one\ntwo\n', 'one', 'ONE'),
    call('2', 'Bash', { command: 'npm test' }),
    result('2', { stdout: 'ok' }),
    ...edit('3', 'a.ts', 'ONE\ntwo\n', 'two', 'TWO'),
  ]);
  const c = changes(items);
  check(
    'a Bash call between two edits to one file keeps them merged',
    c.length === 1 && c[0].editCount === 2 && ticks(items).length === 1,
    `  ${c.length} cards, editCount ${c[0]?.editCount}, ${ticks(items).length} ticks`,
  );
}

{
  const items = fold([
    ...edit('1', 'a.ts', 'one\ntwo\n', 'two', 'two\nTHREE-typo'),
    ...edit('2', 'a.ts', 'one\ntwo\nTHREE-typo\n', 'THREE-typo', 'three'),
  ]);
  const c = changes(items);
  check(
    'a later edit rewriting earlier inserted text yields one clean diff',
    c.length === 1 && c[0].added === 1 && c[0].removed === 0 && !body(c[0]).includes('typo'),
    `  +${c[0]?.added} -${c[0]?.removed}\n${body(c[0] ?? ({ hunks: [] } as never))}`,
  );
}

{
  const items = fold([
    ...edit('1', 'a.ts', 'one\n', 'one', 'ONE'),
    ...write('2', 'a.ts', 'ONE\n', 'final\n', 'update'),
  ]);
  const c = changes(items);
  check(
    'a Write following an Edit on the same file merges into one card',
    c.length === 1 && c[0].editCount === 2 && body(c[0]).includes('+final') && !body(c[0]).includes('ONE'),
    `  ${c.length} cards, editCount ${c[0]?.editCount}\n${body(c[0] ?? ({ hunks: [] } as never))}`,
  );
}

{
  const items = fold(write('1', 'new.ts', null, 'a\nb\nc\n', 'create'));
  const c = changes(items);
  check(
    'a created file shows its content, having no originalFile to diff against',
    c.length === 1 && c[0].created && c[0].removed === 0 && c[0].added === 3,
    `  created ${c[0]?.created}, +${c[0]?.added} -${c[0]?.removed}`,
  );
}

{
  const outside = '/elsewhere/notes.md';
  const items = fold([
    call('1', 'Edit', { file_path: outside }),
    result('1', { filePath: outside, originalFile: 'a\n', oldString: 'a', newString: 'A', structuredPatch: [] }),
  ]);
  check(
    'a file edited outside the worktree reads as a path, not a chain of ..',
    changes(items)[0]?.relPath === outside,
    `  ${changes(items)[0]?.relPath}`,
  );
}

{
  const items = fold([
    call('1', 'Read', { file_path: '/w/a.ts' }),
    result('1', { file: {} }),
    call('2', 'Read', { file_path: '/w/b.ts' }),
    result('2', { file: {} }),
    call('3', 'Read', { file_path: '/w/c.ts' }),
    result('3', { file: {} }),
    call('4', 'Grep', { pattern: 'x' }),
    result('4', { matches: 0 }),
  ]);
  const t = ticks(items);
  check(
    'consecutive calls to one tool fold into a single counted tick',
    t.length === 2 && t[0].count === 3 && t[1].count === 1,
    `  ${t.map((x) => `${x.tool}x${x.count}`).join(', ')}`,
  );
}

{
  const sub = changeEventsOnly(
    parseFeedLines([
      call('s1', 'Bash', { command: 'pytest' }),
      result('s1', { stdout: 'ok' }),
      ...edit('s2', 'a.ts', 'one\n', 'one', 'SUB'),
    ]),
    'code-review',
  );
  const own = parseFeedLines(edit('1', 'a.ts', 'one\n', 'one', 'ONE'));

  {
    const c = changes(foldFeed([...own, ...sub], { taskId: 't', worktreePath: WORKTREE }));
    check(
      "a subagent's change never merges into the session's own card for that file",
      c.length === 2 && c[0].agentLabel === undefined && c[1].agentLabel === 'code-review',
      `  ${c.length} cards: ${c.map((x) => x.agentLabel ?? 'session').join(', ')}`,
    );
  }

  {
    const items = foldFeed(sub, { taskId: 't', worktreePath: WORKTREE });
    check(
      "a subagent's tool chatter stays out of the feed",
      ticks(items).length === 0,
      `  ${ticks(items).length} ticks`,
    );
  }
}

{
  const file = `${WORKTREE}/a.ts`;
  function onDisk(after: string, hunks: string[]): FeedEvent {
    clock += 1000;
    return {
      kind: 'fs',
      ts: clock,
      id: `fs:${clock}`,
      command: "cat >> a.ts <<'PY'",
      filePath: file,
      hunks: [{ newStart: 1, lines: hunks }],
      added: hunks.filter((l) => l.startsWith('+')).length,
      removed: hunks.filter((l) => l.startsWith('-')).length,
      created: false,
      blobSha: blobSha(after),
    };
  }

  {
    const items = foldFeed([onDisk('one\ntwo\n', [' one', '+two'])], { taskId: 't', worktreePath: WORKTREE });
    const c = changes(items);
    check(
      'a change found in the worktree is shown under the command it appeared during',
      c.length === 1 && c[0].command === "cat >> a.ts <<'PY'" && c[0].added === 1,
      `  ${c.length} cards, command ${c[0]?.command}, +${c[0]?.added}`,
    );
  }

  {
    // The tool result and the scan that follows it both describe 'a.ts holds ONE'.
    const items = foldFeed([...parseFeedLines(edit('1', 'a.ts', 'one\n', 'one', 'ONE')), onDisk('ONE\n', ['+ONE'])], {
      taskId: 't',
      worktreePath: WORKTREE,
    });
    check('one write seen twice draws one card', changes(items).length === 1, `  ${changes(items).length} cards`);
  }
}

{
  // Pinned against `git hash-object`, since the whole dedupe rests on it.
  check(
    "a file's identity is the blob id git would give it",
    blobSha('hello\nworld\n') === '94954abda49de8615a048f8d2e64b5de848e27a1',
    `  ${blobSha('hello\nworld\n')}`,
  );
}

{
  const output = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 17a0f47..cbd47a7 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -3,2 +3,3 @@ context',
    ' keep',
    '-gone',
    '+added',
    '+more',
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
    'diff --git a/img.png b/img.png',
    'index aaaa..bbbb 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  const parsed = parseDiffTree(output, WORKTREE);
  check(
    'a diff parses to one entry per patched file, skipping renames and binaries',
    parsed.length === 1 &&
      parsed[0].filePath === `${WORKTREE}/src/a.ts` &&
      parsed[0].added === 2 &&
      parsed[0].removed === 1 &&
      parsed[0].blobSha === 'cbd47a7' &&
      parsed[0].hunks[0].newStart === 3,
    `  ${JSON.stringify(parsed)}`,
  );
}

{
  check(
    'the ignore list catches build output and lockfiles at any depth',
    isIgnored('package-lock.json', DEFAULT_IGNORE) &&
      isIgnored('web/dist/bundle.js', DEFAULT_IGNORE) &&
      isIgnored('a/b/__snapshots__/x.snap', DEFAULT_IGNORE) &&
      !isIgnored('src/main/change-feed.ts', DEFAULT_IGNORE) &&
      !isIgnored('src/distribute.ts', DEFAULT_IGNORE),
  );
}

{
  check(
    'git commands that move the tree are told apart from ones that do not',
    movesTreeWholesale('git checkout -- src tests') &&
      movesTreeWholesale('cd /w && git stash && ls') &&
      !movesTreeWholesale('git apply /tmp/fix.patch') &&
      !movesTreeWholesale('git commit -m "checkout"'),
  );
}

{
  check(
    "a message's addressee resolves to the task's own name",
    messageTargetName('RPC delegatesTo: classpath fallback [e858a2]') === 'RPC delegatesTo: classpath fallback' &&
      messageTargetName('Plain task name') === 'Plain task name' &&
      messageTargetName('Fix RPC [hub] handling [a1b2c3]') === 'Fix RPC [hub] handling',
    `  ${messageTargetName('Fix RPC [hub] handling [a1b2c3]')}`,
  );
}

{
  const long = `cd ${WORKTREE} && git status --short`;
  check(
    'a command reads as the work it does, not the directory it starts in',
    commandLabel(long, WORKTREE) === 'git status --short' &&
      commandLabel(`cd '${WORKTREE}' ; ls`, WORKTREE) === 'ls' &&
      commandLabel('npm test', WORKTREE) === 'npm test' &&
      // A bare cd is the whole command, so it stands rather than vanishing.
      commandLabel(`cd ${WORKTREE}`, WORKTREE) === `cd ${WORKTREE}`,
    `  ${commandLabel(long, WORKTREE)} | ${commandLabel(`cd '${WORKTREE}' ; ls`, WORKTREE)}`,
  );
}

{
  // A turn often reasons and then acts without ever emitting a text block, and
  // that reasoning is the only account of why the change below it happened.
  const items = fold([thought('Fixing the ref map.'), thought(''), ...edit('1', 'a.ts', 'a\n', 'a', 'A')]);
  const narration = items.filter((i) => i.kind === 'narration');
  check(
    'a thought reads as narration, and an empty one is not narration at all',
    narration.length === 1 && narration[0].kind === 'narration' && narration[0].thinking === true,
    `  ${items.map((i) => i.kind).join(', ')}`,
  );
}

{
  // A backgrounded command's tool result lands at once while it keeps writing,
  // so only its completion notice may close the window it is attributed by.
  const notice = (toolUseId: string) =>
    JSON.stringify({
      type: 'user',
      timestamp: at(),
      message: {
        content: [
          {
            type: 'text',
            text: `<task-notification> <task-id>bg1</task-id> <tool-use-id>${toolUseId}</tool-use-id> </task-notification>`,
          },
        ],
      },
    });
  const events = parseFeedLines([notice('toolu_9'), text('after')]);
  const done = events.find((e) => e.kind === 'bgdone');
  check(
    "a background command's completion notice names the call that started it",
    done?.kind === 'bgdone' && done.id === 'toolu_9' && events.some((e) => e.kind === 'text'),
    `  ${events.map((e) => e.kind).join(', ')}`,
  );
  check('a completion notice is not itself a feed item', changes(fold([notice('toolu_9')])).length === 0);
}

process.exit(failed === 0 ? 0 : 1);
