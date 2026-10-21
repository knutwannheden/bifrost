import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import { Board } from './board.ts';
import { createServer } from './mcp.ts';

test('acquire over MCP is granted, and a second exclusive claim is told who holds it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'headroom-mcp-'));
  process.env.HEADROOM_PS = join(dir, 'ps-quiet.sh');
  writeFileSync(
    process.env.HEADROOM_PS,
    '#!/bin/sh\nprintf "  PID  PPID      TIME COMMAND\\n4243 1 0:00.00 idle\\n"\n',
    { mode: 0o755 },
  );
  process.env.HEADROOM_SAMPLE_MS = '20';
  const board = Board.inMemory();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(board, (as) => as ?? 'anon').connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);

  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toContain('headroom_acquire');

  const first = await client.callTool({
    name: 'headroom_acquire',
    arguments: { resource: 'cpu', mode: 'exclusive', why: 'JMH run', as: 'bench' },
  });
  const said = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text: string }[])[0].text;
  expect(said(first)).toMatch(/granted #1/);

  const second = await client.callTool({
    name: 'headroom_acquire',
    arguments: { resource: 'cpu', mode: 'exclusive', why: 'profiling', as: 'prof' },
  });
  expect(said(second)).toMatch(/waiting #2/);
  expect(said(second)).toContain('"bench"');
  await client.close();
});
