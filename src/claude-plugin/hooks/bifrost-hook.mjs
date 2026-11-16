// Forwards one hook's JSON from stdin to the Bifrost API, and prints what the agent should see.
// Usage: node bifrost-hook.mjs notify | prompt-submit | session-start | permission
//
// The permission hook runs before every tool call, and node:http takes longer to load than the
// rest of this script runs. So it speaks HTTP over a plain socket. Bifrost's server answers an
// HTTP/1.0 request with one unchunked body and closes the connection.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const MODES = {
  notify: { route: '/hook', timeout: 2000, enrich: true, print: () => false },
  // Codex rejects output that is not a hook answer, such as the API's {"ok":true}.
  'prompt-submit': {
    route: '/hook',
    timeout: 2000,
    enrich: true,
    print: (body) => body.includes('hookSpecificOutput'),
  },
  'session-start': { route: '/session-start', timeout: 2000, enrich: true, print: () => false },
  // Held open until the user answers in Bifrost.
  permission: { route: '/permission', timeout: 120_000, enrich: false, print: (body) => body !== '' },
};

const mode = MODES[process.argv[2]];
if (!mode) process.exit(0);

let port = process.env.BIFROST_API_PORT;
if (!port) {
  try {
    port = fs.readFileSync(path.join(os.homedir(), '.bifrost', 'api-port'), 'utf8').trim();
  } catch {}
}
if (!port) process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}
if (mode.enrich) {
  input.bifrost_context = process.env.BIFROST_CONTEXT || 'code';
  if (process.env.BIFROST_TASK_ID) input.bifrost_task_id = process.env.BIFROST_TASK_ID;
}
const body = Buffer.from(JSON.stringify(input));

setTimeout(() => process.exit(0), mode.timeout).unref();
const socket = net.connect(Number(port), '127.0.0.1');
socket.on('error', () => process.exit(0));
let response = '';
socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  response += chunk;
});
socket.on('end', () => {
  const split = response.indexOf('\r\n\r\n');
  const answer = split < 0 ? '' : response.slice(split + 4);
  if (mode.print(answer)) process.stdout.write(`${answer}\n`);
});
socket.write(
  `POST ${mode.route} HTTP/1.0\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`,
);
socket.end(body);
