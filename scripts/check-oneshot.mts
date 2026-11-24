/**
 * Copilot has no schema option, so Bifrost finds the JSON in its reply and
 * checks the required keys itself. A walkthrough reads Claude's stream-json
 * line by line, for progress. Run with `npm run check:oneshot`.
 */
import { jsonReply, streamDelta } from '../src/main/oneshot.ts';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const schema = { type: 'object', required: ['summary'] };

const fenced = 'Here is the {summary}:\n```json\n{"summary": "Adds a {brace} setting"}\n```\nAsk if you want {more}.\n';
check(
  'a fenced reply with braces in the sentences around it yields its object',
  JSON.stringify(jsonReply(fenced, schema)) === '{"summary":"Adds a {brace} setting"}',
  JSON.stringify(jsonReply(fenced, schema)),
);
check('an object without a required key is no reply', jsonReply('{"title": "x"}', schema) === null);

const nested = {
  type: 'object',
  required: ['steps'],
  properties: { steps: { type: 'array', items: { type: 'object', required: ['comments'] } } },
};
check(
  'an array item without a required key is no reply',
  jsonReply('{"steps": [{"comments": []}, {"title": "x"}]}', nested) === null,
);

const delta = (event: unknown) => JSON.stringify({ type: 'stream_event', event });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
check(
  'a thinking delta yields its text',
  same(streamDelta(delta({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'I am' } })), {
    kind: 'thinking',
    text: 'I am',
  }),
);
check(
  'a delta of the structured output yields its piece of JSON',
  same(streamDelta(delta({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"ti' } })), {
    kind: 'output',
    text: '{"ti',
  }),
);
check(
  'the result line yields the structured output',
  same(streamDelta(JSON.stringify({ type: 'result', subtype: 'success', structured_output: { a: 1 } })), {
    kind: 'result',
    value: { a: 1 },
  }),
);
check(
  'other lines yield nothing',
  streamDelta(JSON.stringify({ type: 'system', subtype: 'thinking_tokens' })) === null &&
    streamDelta(delta({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'x' } })) === null &&
    streamDelta('') === null,
);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
