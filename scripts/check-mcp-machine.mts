/**
 * The MCP server describes create_task's machine values as they work where it
 * runs. Runs the server from source against the dependencies of the plugin
 * Bifrost installed. Run with `npm run check:mcp-machine`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} — ${name}${ok || !detail ? '' : `\n  ${detail}`}`);
}

const installed = path.join(os.homedir(), '.bifrost', 'marketplace', 'bifrost', 'mcp', 'node_modules');
if (!fs.existsSync(path.join(installed, '@modelcontextprotocol'))) {
  console.log('skipped — no installed plugin to borrow the MCP dependencies from');
  process.exit(0);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-mcp-')));
fs.cpSync('src/claude-plugin/mcp', path.join(root, 'mcp'), {
  recursive: true,
  filter: (file) => path.basename(file) !== 'node_modules',
});
fs.cpSync('src/claude-plugin/skills', path.join(root, 'skills'), { recursive: true });
fs.symlinkSync(installed, path.join(root, 'mcp', 'node_modules'));

/** A server on the named machine whose home holds these port files, spoken to over stdio. */
function serve(machine: string, ports: Record<string, string | number>, extra: NodeJS.ProcessEnv = {}) {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  fs.mkdirSync(path.join(home, '.bifrost'));
  for (const [file, port] of Object.entries(ports)) fs.writeFileSync(path.join(home, '.bifrost', file), `${port}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BIFROST_MACHINE: machine };
  for (const key of ['BIFROST_API_PORT', 'BIFROST_TASK_ID', 'BIFROST_CONTEXT', 'BIFROST_AGENT']) delete env[key];
  Object.assign(env, extra);
  const server = spawn('node', [path.join(root, 'mcp', 'server.mjs')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = '';
  let next = 1;
  server.stdout.on('data', (chunk) => {
    out += chunk;
  });
  const send = (message: object) => server.stdin.write(`${JSON.stringify(message)}\n`);
  const request = async (method: string, params: object): Promise<Record<string, unknown>> => {
    const id = next++;
    send({ jsonrpc: '2.0', id, method, params });
    const end = Date.now() + 10_000;
    while (Date.now() < end) {
      const line = out.split('\n').find((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`));
      if (line) return JSON.parse(line).result;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no answer to ${method}`);
  };
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'check', version: '0' },
  }).then((result) => {
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result as { instructions?: string };
  });
  return { ready, request, close: () => server.kill() };
}

async function machineDescription(machine: string, ports: Record<string, string | number>): Promise<string> {
  const server = serve(machine, ports);
  try {
    await server.ready;
    const { tools } = (await server.request('tools/list', {})) as {
      tools: Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> } }>;
    };
    return tools.find((t) => t.name === 'create_task')?.inputSchema.properties.machine.description ?? '';
  } finally {
    server.close();
  }
}

try {
  const own = await machineDescription('perf', { 'api-port': '7623', 'instance-port': '7623' });
  const reached = await machineDescription('recipes', { 'api-port': '50123' });
  check(
    "create_task offers 'local' and 'ide' only where its API is the machine's own instance",
    own.includes('"perf"') && own.includes("'ide'") && own.includes("'local'") && !reached.includes("'ide'"),
    JSON.stringify({ own, reached }),
  );

  {
    const copilot = serve('', { 'api-port': '7623' }, { BIFROST_AGENT: 'copilot' });
    const claude = serve('', { 'api-port': '7623' });
    try {
      const [other, own] = await Promise.all([copilot.ready, claude.ready]);
      check(
        'a session of an agent without SendMessage is told to reach other tasks with message_task',
        !!other.instructions?.includes('use message_task') &&
          !other.instructions.includes('use the built-in SendMessage') &&
          !!own.instructions?.includes('use the built-in SendMessage'),
        JSON.stringify({ other: other.instructions, own: own.instructions?.slice(0, 80) }),
      );
    } finally {
      copilot.close();
      claude.close();
    }
  }

  // A machine without its own instance, whose API is the IDE's.
  const requests: Array<{ route: string; body: Record<string, unknown> }> = [];
  const lastBody = () => requests.at(-1)?.body;
  const api = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      const body = JSON.parse(data || '{}') as Record<string, unknown>;
      const route = req.url ?? '';
      requests.push({ route, body });
      const answers: Record<string, object> = {
        '/find-task': { ok: true, task: { repoId: 'caller-repo' } },
        '/create-task': body.async
          ? { ok: true, pending: true }
          : { id: 'new-task', name: body.name, branch: 'new-task' },
        '/epic/get': { ok: true, state: { epic: { goal: 'Ship a change' }, members: [] } },
        '/epic/update': { ok: true, update: { seq: 1 } },
        '/epic/report': { ok: true, update: { seq: 2 } },
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answers[route] ?? {}));
    });
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const server = serve('recipes', { 'api-port': (api.address() as AddressInfo).port });
  try {
    await server.ready;
    await server.request('tools/call', {
      name: 'create_task',
      arguments: { repo: '/r', prompt: 'x', machine: 'local' },
    });
    check(
      'create_task sends "local" as the machine the session runs on',
      lastBody()?.machine === 'recipes',
      JSON.stringify(requests),
    );

    const codex = serve('recipes', { 'api-port': (api.address() as AddressInfo).port }, { BIFROST_AGENT: 'codex' });
    try {
      await codex.ready;
      await codex.request('tools/call', { name: 'create_task', arguments: { repo: '/r', prompt: 'x' } });
      const inherited = lastBody()?.launch;
      await codex.request('tools/call', {
        name: 'create_task',
        arguments: { repo: '/r', prompt: 'x', agent: 'claude', model: 'opus', effort: 'high' },
      });
      const named = lastBody()?.launch;
      check(
        "create_task gives the new task its creator's agent, or the agent, model and effort it names",
        JSON.stringify(inherited) === JSON.stringify({ agent: 'codex' }) &&
          JSON.stringify(named) === JSON.stringify({ agent: 'claude', model: 'opus', effort: 'high' }),
        JSON.stringify({ inherited, named }),
      );
    } finally {
      codex.close();
    }

    const epic = serve('', { 'api-port': (api.address() as AddressInfo).port }, { BIFROST_TASK_ID: 'epic-root' });
    try {
      await epic.ready;
      const call = (name: string, args: object = {}) => epic.request('tools/call', { name, arguments: args });
      const replyText = (result: Record<string, unknown>) => {
        const content = result.content as Array<{ text: string }> | undefined;
        return content?.[0]?.text ?? '';
      };
      const catalogReply = await call('list_epic_templates');
      const templates = JSON.parse(replyText(catalogReply) || '[]') as Array<{
        id: string;
        title: string;
        text: string;
      }>;
      const preset = templates.find((template) => template.id === 'implement-review');
      const presetResult = await call('create_epic', {
        name: 'Ship a change',
        goal: 'A tested fix',
        template_id: 'implement-review',
      });
      const chosen = lastBody();
      const inlineText = '  Investigate.\n\nThen report.\n';
      const inlineResult = await call('create_epic', {
        name: 'Learn why',
        goal: 'Learn why',
        template_text: inlineText,
        repo: '/r',
      });
      const inline = lastBody();
      const requestCount = requests.length;
      const ambiguous = await call('create_epic', {
        name: 'Ship a change',
        goal: 'A tested fix',
        template_id: 'implement-review',
        template_text: 'Investigate',
      });
      const unnamed = await call('create_epic', { goal: 'A tested fix', template_id: 'plan-first' });
      check(
        'create_epic saves the chosen prose and returns an actual task id',
        !!preset?.title &&
          !!preset.text &&
          isDeepStrictEqual(
            templates.map(({ id }) => id),
            ['implement-review', 'implement-review-measure', 'investigate-in-parallel', 'plan-first'],
          ) &&
          replyText(presetResult).includes('new-task') &&
          replyText(inlineResult).includes('new-task') &&
          isDeepStrictEqual(chosen?.epic, { goal: 'A tested fix', template: preset.text, templateId: preset.id }) &&
          isDeepStrictEqual(inline?.epic, { goal: 'Learn why', template: inlineText }) &&
          chosen?.async === false &&
          chosen?.repoId === 'caller-repo' &&
          inline?.repoPath === '/r' &&
          ambiguous?.isError === true &&
          unnamed?.isError === true &&
          requests.length === requestCount,
        JSON.stringify({ templates, chosen, inline, presetResult, ambiguous, unnamed }),
      );

      const queued = await call('create_task', { prompt: 'Do work', name: 'queued' });
      const queuedBody = lastBody();
      const confirmed = await call('create_task', { prompt: 'Do work', wait: true });
      check(
        'create_task waits for an actual task id only when requested',
        queuedBody?.async === true &&
          replyText(queued).includes('is being created') &&
          lastBody()?.async === false &&
          replyText(confirmed).includes('new-task'),
      );

      const change = { kind: 'decision', id: 'scope', question: 'Change scope?', status: 'needs-user' };
      const before = requests.length;
      const state = await call('get_epic');
      await call('update_epic', { change });
      await call('report_epic_result', { epicId: 'other-epic', itemId: 'review', reportId: 'first', text: 'Ready' });
      check(
        'epic tools address the coordinator and carry the calling task identity',
        replyText(state).includes('Ship a change') &&
          isDeepStrictEqual(requests.slice(before), [
            { route: '/epic/get', body: { taskId: 'epic-root', callerTaskId: 'epic-root' } },
            { route: '/epic/update', body: { taskId: 'epic-root', callerTaskId: 'epic-root', change } },
            {
              route: '/epic/report',
              body: {
                taskId: 'other-epic',
                callerTaskId: 'epic-root',
                itemId: 'review',
                reportId: 'first',
                text: 'Ready',
              },
            },
          ]),
        JSON.stringify(requests.slice(before)),
      );
    } finally {
      epic.close();
    }
  } finally {
    server.close();
    api.close();
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
