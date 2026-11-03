/**
 * The MCP server describes create_task's machine values as they work where it
 * runs. Runs the server from source against the dependencies of the plugin
 * Bifrost installed. Run with `npm run check:mcp-machine`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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

/** create_task's machine description, from a server on the named machine whose home holds these port files. */
async function machineDescription(machine: string, ports: Record<string, string>): Promise<string> {
  const home = fs.mkdtempSync(path.join(root, 'home-'));
  fs.mkdirSync(path.join(home, '.bifrost'));
  for (const [file, port] of Object.entries(ports)) fs.writeFileSync(path.join(home, '.bifrost', file), `${port}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, BIFROST_MACHINE: machine };
  for (const key of ['BIFROST_API_PORT', 'BIFROST_TASK_ID', 'BIFROST_CONTEXT']) delete env[key];
  const server = spawn('node', [path.join(root, 'server.mjs')], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const send = (message: object) => server.stdin.write(`${JSON.stringify(message)}\n`);
  let out = '';
  const listed = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no tools/list answer')), 10_000);
    server.stdout.on('data', (chunk) => {
      out += chunk;
      const line = out.split('\n').find((l) => l.includes('"id":2'));
      if (!line) return;
      clearTimeout(timer);
      const tools = JSON.parse(line).result.tools as Array<{
        name: string;
        inputSchema: { properties: Record<string, { description?: string }> };
      }>;
      resolve(tools.find((t) => t.name === 'create_task')?.inputSchema.properties.machine.description ?? '');
    });
  });
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'check', version: '0' } },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  try {
    return await listed;
  } finally {
    server.kill();
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
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
