/**
 * Copilot has no schema option, so Bifrost finds the JSON in its reply and
 * checks the required keys itself. Run with `npm run check:oneshot`.
 */
import { jsonReply } from '../src/main/oneshot.ts';

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

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
