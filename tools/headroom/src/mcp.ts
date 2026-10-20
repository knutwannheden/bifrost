import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Board } from './board.ts';
import {
  formatLeft,
  granted,
  holderName,
  type NameResolver,
  nextUp,
  parseDuration,
  queued,
  sessionPid,
} from './common.ts';
import { hookOutput } from './hook.ts';

const WHY = 'What you are doing, and what breaks if someone proceeds anyway. Other sessions decide from this.';
const AS =
  'The name other sessions message you by (what ListAgents shows for you). Defaults to BIFROST_SESSION_NAME or HEADROOM_AS.';

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

/** The CLI's commands as MCP tools, so a session can claim without a shell. */
export function createServer(board: Board, name: NameResolver = holderName): McpServer {
  const server = new McpServer(
    { name: 'headroom', version: '0.1.0' },
    {
      instructions:
        'Shared resources on this machine are coordinated through advisory claims. Before CPU-heavy work ' +
        '(benchmarks, profiling, full builds, long test suites) call headroom_acquire: exclusive when another ' +
        'heavy process would corrupt your numbers, shared when it would only slow you down. The claim is advisory — ' +
        'nobody is blocked, but everyone sees it, and a holder asked to yield stops and releases.',
    },
  );

  server.registerTool(
    'headroom_status',
    {
      title: 'Headroom status',
      description: 'Who holds and who waits for each shared resource, with their reasons and time left.',
      inputSchema: { resource: z.string().optional().describe('One resource, e.g. cpu; all when omitted.') },
    },
    async ({ resource }) => {
      const out = hookOutput(board.status(resource), null, Date.now());
      return text(out ? out.hookSpecificOutput.additionalContext : 'nothing claimed');
    },
  );

  server.registerTool(
    'headroom_acquire',
    {
      title: 'Acquire a resource',
      description:
        'Claim a shared resource before heavy work. exclusive holds alone (benchmarks, profiling); shared holds ' +
        'alongside other shared claims (test suites, builds). Granted at once when the resource fits, otherwise queued ' +
        'behind what holds it, with the holders named so you can message them or wait.',
      inputSchema: {
        resource: z.string().describe("Resource name, e.g. 'cpu'."),
        mode: z.enum(['shared', 'exclusive']),
        why: z.string().describe(WHY),
        ttl: z
          .string()
          .optional()
          .describe('How long you expect to hold it, e.g. 10m, 1h (default 10m). Renew to extend.'),
        priority: z.number().int().optional().describe('Higher goes ahead in the queue (default 0).'),
        as: z.string().optional().describe(AS),
      },
    },
    async ({ resource, mode, why, ttl, priority, as }) => {
      const c = board.claim({
        resource,
        mode,
        holder: await name(as),
        sessionId: process.env.CLAUDE_CODE_SESSION_ID,
        pid: sessionPid(),
        why,
        priority,
        ttlMs: parseDuration(ttl ?? '10m'),
      });
      return text(c.grantedAt !== null ? granted(board, c) : queued(board, c));
    },
  );

  server.registerTool(
    'headroom_release',
    {
      title: 'Release a claim',
      description: 'Release a claim you hold or are waiting on. Also lifts a notice.',
      inputSchema: { id: z.number().int() },
    },
    async ({ id }) => {
      return text(`released #${id}${nextUp(board.release(id))}`);
    },
  );

  server.registerTool(
    'headroom_renew',
    {
      title: 'Renew a claim',
      description: 'Extend a claim from now. A claim nobody renews lapses at its ttl, whether held or waiting.',
      inputSchema: {
        id: z.number().int(),
        ttl: z.string().optional().describe('e.g. 10m (default 10m)'),
        why: z
          .string()
          .optional()
          .describe('A restated reason, e.g. progress or a revised estimate, shown to waiters.'),
      },
    },
    async ({ id, ttl, why }) => {
      const c = board.renew(id, parseDuration(ttl ?? '10m'), why);
      return text(c.grantedAt !== null ? granted(board, c) : queued(board, c));
    },
  );

  server.registerTool(
    'headroom_notice',
    {
      title: 'Post a notice',
      description:
        'Post a notice on a resource: nobody holds it, but no new claim is granted while it stands. For conditions like ' +
        'generator power or a scheduled measurement window. Lift it with headroom_release.',
      inputSchema: {
        resource: z.string(),
        why: z.string().describe('The condition and what to do instead.'),
        ttl: z.string().optional().describe('e.g. 1h (default 1h)'),
        as: z.string().optional().describe(AS),
      },
    },
    async ({ resource, why, ttl, as }) => {
      const c = board.claim({
        resource,
        mode: 'notice',
        holder: await name(as, 'notice'),
        why,
        ttlMs: parseDuration(ttl ?? '1h'),
      });
      return text(`notice #${c.id} on ${c.resource} for ${formatLeft(c, Date.now())}. Lift it with headroom_release.`);
    },
  );

  server.registerTool(
    'headroom_seize',
    {
      title: 'Seize a resource',
      description:
        'Take a resource ahead of everything queued and ask the current holders to stop. For work that cannot wait. ' +
        'The holders are told on their next prompt; message them with SendMessage as well, then wait for the grant.',
      inputSchema: {
        resource: z.string(),
        why: z.string().describe(WHY),
        ttl: z.string().optional().describe('e.g. 10m (default 10m)'),
        as: z.string().optional().describe(AS),
      },
    },
    async ({ resource, why, ttl, as }) => {
      const { claim, yielding } = board.seize({
        resource,
        holder: await name(as),
        sessionId: process.env.CLAUDE_CODE_SESSION_ID,
        pid: sessionPid(),
        why,
        ttlMs: parseDuration(ttl ?? '10m'),
      });
      if (claim.grantedAt !== null) return text(granted(board, claim));
      return text(
        `seizing #${claim.id} — asked to yield: ${yielding.map((c) => `"${c.holder}"`).join(', ')}.\n` +
          `Tell them with SendMessage, then run \`headroom wait ${claim.id}\` in Bash.`,
      );
    },
  );

  return server;
}

/** Serves over stdio until the client hangs up. */
export async function serve(board: Board): Promise<void> {
  await createServer(board).connect(new StdioServerTransport());
  await new Promise<void>((resolve) => process.stdin.on('close', resolve));
}
