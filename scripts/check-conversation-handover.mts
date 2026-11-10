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

const { handOverConversation, switchAgent } = await import('../src/main/conversation-handover.ts');

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

  const same = switchAgent({ agent: 'copilot', sessionId: 'p1' }, 'copilot', handOver);
  check(
    'a task staying with its agent keeps its conversation',
    Object.keys(same.changes).length === 0 && same.prompt === undefined && asked.length === 2,
    JSON.stringify(same),
  );
}

fs.rmSync(home, { recursive: true, force: true });
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
