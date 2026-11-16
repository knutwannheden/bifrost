/**
 * A task whose session starts under another agent hands its conversation over
 * as text, read from the previous agent's own transcript. These write each
 * agent's transcript format under a temporary home. Run with
 * `npm run check:conversation-handover`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-handover-')));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.COPILOT_HOME;
delete process.env.CODEX_HOME;

const {
  anyTranscript,
  conversationExcerpt,
  handOverConversation,
  lastReply,
  remoteHandOver,
  switchAgent,
  transcriptFile,
} = await import('../src/main/conversation-handover.ts');

const lines = (...records: unknown[]) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

write(
  path.join(home, '.claude', 'projects', '-some-dir', 'c1.jsonl'),
  lines(
    { type: 'user', message: { role: 'user', content: 'Add a cache to the parser.' } },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'secret' },
          { type: 'text', text: 'I will add an LRU cache.' },
          { type: 'tool_use', name: 'Edit', input: {} },
        ],
      },
    },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'edited' }] } },
    { type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
  ),
);
write(
  path.join(home, '.copilot', 'session-state', 'p1', 'events.jsonl'),
  lines(
    { type: 'user.message', data: { content: 'Run the tests.' } },
    { type: 'assistant.message', data: { content: '' } },
    { type: 'tool.execution_start', data: { toolName: 'bash' } },
    { type: 'assistant.message', data: { content: 'They pass.' } },
  ),
);
write(
  path.join(home, '.codex', 'sessions', '2026', '11', '10', 'rollout-2026-11-10T04-33-44-x1.jsonl'),
  lines(
    { type: 'session_meta', payload: { id: 'x1' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex' }] },
    },
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }],
      },
    },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Rename the flag.' }] },
    },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell' } },
    {
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Renamed.' }] },
    },
  ),
);

const read = (file: string | undefined) => (file ? fs.readFileSync(file, 'utf-8') : '(none)');

{
  const prompt = handOverConversation('t1', 'claude', 'c1') ?? '';
  const file = path.join(home, '.bifrost', 'sessions', 't1', 'conversation.md');
  check(
    "Claude's conversation is handed over as its prompts and replies, without tool traffic, thinking or meta records",
    read(file) === '## User\n\nAdd a cache to the parser.\n\n## Claude\n\nI will add an LRU cache.\n',
    JSON.stringify(read(file)),
  );
  check('the prompt for the next agent names the file to read', prompt.includes(file), prompt);
}
check(
  "Copilot's conversation is handed over from its event log",
  (handOverConversation('t2', 'copilot', 'p1'),
  read(path.join(home, '.bifrost', 'sessions', 't2', 'conversation.md'))) ===
    '## User\n\nRun the tests.\n\n## Copilot\n\nThey pass.\n',
);
check(
  "Codex's conversation is handed over from its rollout, without the context it adds as user messages",
  (handOverConversation('t3', 'codex', 'x1'),
  read(path.join(home, '.bifrost', 'sessions', 't3', 'conversation.md'))) ===
    '## User\n\nRename the flag.\n\n## Codex\n\nRenamed.\n',
);
check(
  "a Copilot or Codex conversation's last reply is the agent's last message, for send_prompt to return",
  lastReply('copilot', 'p1') === 'They pass.' && lastReply('codex', 'x1') === 'Renamed.',
  JSON.stringify([lastReply('copilot', 'p1'), lastReply('codex', 'x1')]),
);
check(
  'a conversation whose transcript is gone hands nothing over',
  handOverConversation('t4', 'claude', 'gone') === undefined,
);

{
  const long = 'x'.repeat(1000);
  write(
    path.join(home, '.copilot', 'session-state', 'p2', 'events.jsonl'),
    lines(
      ...Array.from({ length: 200 }, (_, i) => ({
        type: i % 2 ? 'assistant.message' : 'user.message',
        data: { content: `${i} ${long}` },
      })),
    ),
  );
  handOverConversation('t5', 'copilot', 'p2');
  const text = read(path.join(home, '.bifrost', 'sessions', 't5', 'conversation.md'));
  check(
    'a long conversation is cut to its most recent part',
    text.length < 200 * 1000 && text.includes('199 x') && !text.includes('\n\n0 x'),
    `${text.length}`,
  );

  write(
    path.join(home, '.copilot', 'session-state', 'p3', 'events.jsonl'),
    lines({ type: 'user.message', data: { content: `${long.repeat(100)} end` } }),
  );
  handOverConversation('t6', 'copilot', 'p3');
  const one = read(path.join(home, '.bifrost', 'sessions', 't6', 'conversation.md'));
  check(
    'a single turn too long to keep whole keeps its end',
    one.length < 100 * 1000 && one.endsWith('end\n'),
    `${one.length}`,
  );
}

{
  const many = path.join(home, '.copilot', 'session-state', 'p4', 'events.jsonl');
  const ys = 'y'.repeat(5000);
  write(
    many,
    lines(
      ...Array.from({ length: 30 }, (_, i) => ({
        type: i % 2 ? 'assistant.message' : 'user.message',
        data: { content: i === 3 ? `turn 3 ${ys}` : i === 29 ? `${ys} turn 29 done` : `turn ${i}` },
      })),
    ),
  );
  const excerpt = conversationExcerpt([{ agent: 'copilot', file: many }]) ?? '';
  const kept = [...excerpt.matchAll(/turn (\d+)/g)].map((m) => Number(m[1]));
  check(
    "a title or summary reads the first four and last six turns of the agent's own transcript",
    JSON.stringify(kept) === JSON.stringify([0, 1, 2, 3, 24, 25, 26, 27, 28, 29]) &&
      excerpt.startsWith('## User\n\nturn 0') &&
      excerpt.includes('[20 turns left out]'),
    JSON.stringify(kept),
  );
  check(
    'a long turn is cut to its start in the head and to its end in the tail',
    excerpt.length < 4000 && excerpt.includes('## Copilot\n\nturn 3 yyy') && excerpt.includes('yyy turn 29 done\n'),
    `${excerpt.length}`,
  );

  const codex = transcriptFile('codex', 'x1') ?? '';
  check(
    'a conversation shorter than the excerpt is kept whole, each turn once',
    conversationExcerpt([{ agent: 'codex', file: codex }]) === '## User\n\nRename the flag.\n\n## Codex\n\nRenamed.\n',
    JSON.stringify(conversationExcerpt([{ agent: 'codex', file: codex }])),
  );

  const switched = conversationExcerpt([anyTranscript('x1'), anyTranscript('p1')].filter((t) => t !== undefined)) ?? '';
  check(
    'a task that switched agents reads its earlier sessions first, each turn under the agent that kept it',
    switched ===
      '## User\n\nRename the flag.\n\n## Codex\n\nRenamed.\n\n## User\n\nRun the tests.\n\n## Copilot\n\nThey pass.\n',
    JSON.stringify(switched),
  );
  check(
    'a transcript that is gone gives no excerpt',
    conversationExcerpt([{ agent: 'codex', file: path.join(home, 'missing.jsonl') }]) === undefined,
  );

  const slash = path.join(home, '.claude', 'projects', '-some-dir', 'c5.jsonl');
  write(
    slash,
    lines(
      {
        type: 'user',
        message: {
          content:
            '<command-name>/feature-dev</command-name>\n<command-message>feature-dev</command-message>\n<command-args>add a cache</command-args>',
        },
      },
      { type: 'user', isMeta: true, message: { content: 'the skill body' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
    ),
  );
  check(
    'a prompt given as a slash command keeps the command and its arguments',
    conversationExcerpt([{ agent: 'claude', file: slash }]) ===
      '## User\n\n/feature-dev add a cache\n\n## Claude\n\nOn it.\n',
    JSON.stringify(conversationExcerpt([{ agent: 'claude', file: slash }])),
  );
}

{
  const asked: string[] = [];
  const handOver = (was: string, id: string) => {
    asked.push(`${was}:${id}`);
    return 'carry on';
  };
  const moved = switchAgent({ agent: undefined, sessionId: 'c1', sessionHistory: ['c0'] }, 'copilot', handOver);
  check(
    "a Claude task starting under Copilot keeps Claude's id in its history and gets a new one with the handover prompt",
    moved.prompt === 'carry on' &&
      asked.join() === 'claude:c1' &&
      moved.changes.agent === 'copilot' &&
      JSON.stringify(moved.changes.sessionHistory) === JSON.stringify(['c0', 'c1']) &&
      typeof moved.changes.sessionId === 'string' &&
      moved.changes.sessionId !== 'c1',
    JSON.stringify(moved),
  );

  const codex = switchAgent({ agent: 'claude', sessionId: 'c2' }, 'codex', handOver);
  check(
    'a task starting under Codex has no session id until Codex reports one',
    'sessionId' in codex.changes && codex.changes.sessionId === undefined,
    JSON.stringify(codex),
  );

  const running = switchAgent({ agent: undefined, sessionId: 'c3' }, 'codex', handOver, true);
  check(
    'a task whose session is still running keeps its agent and conversation until it starts again',
    Object.keys(running.changes).length === 0 && running.prompt === undefined && asked.length === 2,
    JSON.stringify(running),
  );

  const same = switchAgent({ agent: 'copilot', sessionId: 'p1' }, 'copilot', handOver);
  check(
    'a task staying with its agent keeps its conversation',
    Object.keys(same.changes).length === 0 && same.prompt === undefined && asked.length === 2,
    JSON.stringify(same),
  );
}

process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude-work');
check(
  "a session on another machine is pointed at Claude's transcript under the config dir sessions run with",
  remoteHandOver('claude', 'c9').includes('~/.claude-work/projects/*/c9.jsonl'),
  remoteHandOver('claude', 'c9'),
);
delete process.env.CLAUDE_CONFIG_DIR;

fs.rmSync(home, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
