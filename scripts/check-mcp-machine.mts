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
fs.copyFileSync('src/claude-plugin/mcp/server.mjs', path.join(root, 'server.mjs'));
fs.copyFileSync('src/claude-plugin/mcp/package.json', path.join(root, 'package.json'));
fs.symlinkSync(installed, path.join(root, 'node_modules'));

/** A server on the named machine whose home holds these port files, spoken to over stdio. */
function serve(machine: string, ports: Record<string, string | number>, extra: NodeJS.ProcessEnv = {}) {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  fs.mkdirSync(path.join(home, '.bifrost'));
  for (const [file, port] of Object.entries(ports)) fs.writeFileSync(path.join(home, '.bifrost', file), `${port}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BIFROST_MACHINE: machine };
  for (const key of ['BIFROST_API_PORT', 'BIFROST_TASK_ID', 'BIFROST_CONTEXT', 'BIFROST_AGENT']) delete env[key];
  Object.assign(env, extra);
  const server = spawn('node', [path.join(root, 'server.mjs')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
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
        'a session of an agent without SendMessage is told to reach other tasks with send_prompt',
        !!other.instructions?.includes('use send_prompt') &&
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
  const bodies: Array<Record<string, unknown>> = [];
  const api = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      bodies.push(JSON.parse(data || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, pending: true }));
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
      bodies.at(-1)?.machine === 'recipes',
      JSON.stringify(bodies),
    );
  } finally {
    server.close();
    api.close();
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
