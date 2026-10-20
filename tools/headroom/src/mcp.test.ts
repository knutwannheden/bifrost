import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, test } from 'vitest';
import { Board } from './board.ts';
import { createServer } from './mcp.ts';

test('acquire over MCP is granted, and a second exclusive claim is told who holds it', async () => {
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
