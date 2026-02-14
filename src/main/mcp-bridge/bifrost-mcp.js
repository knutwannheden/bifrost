#!/usr/bin/env node
'use strict';

// Bifrost MCP Bridge — self-contained, no npm dependencies
// Implements MCP (JSON-RPC 2.0 over stdio) and forwards tool calls to Bifrost's HTTP API.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TASK_ID = process.env.BIFROST_TASK_ID || null;

function getApiPort() {
  if (process.env.BIFROST_API_PORT) return Number(process.env.BIFROST_API_PORT);
  try {
    const portFile = path.join(os.homedir(), '.bifrost', 'api-port');
    return Number(fs.readFileSync(portFile, 'utf-8').trim());
  } catch {
    return null;
  }
}

function apiCall(endpoint, body) {
  const port = getApiPort();
  if (!port) return Promise.reject(new Error('Bifrost API not running'));

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            const json = JSON.parse(text);
            if (res.statusCode >= 400) reject(new Error(json.error || `HTTP ${res.statusCode}`));
            else resolve(json);
          } catch { reject(new Error(`Invalid JSON: ${text}`)); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// MCP tool definitions
const TOOLS = [
  {
    name: 'resolve_context',
    description: 'Resolve a Bifrost context reference [Bifrost #N] to its content. Use when user messages contain [Bifrost #N] patterns.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'number', description: 'The context reference number N from [Bifrost #N]' } },
      required: ['id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all Bifrost tasks with their status, branch, and worktree path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_task_diff',
    description: 'Get the git diff for a Bifrost task. Defaults to the calling task if no taskId specified.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID (optional, defaults to calling task)' } },
    },
  },
  {
    name: 'get_activity_log',
    description: 'Get recent activity entries (file changes, commits, Claude events) for a Bifrost task.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID (optional, defaults to calling task)' },
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
      },
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'resolve_context': {
      const entry = await apiCall('/resolve-context', { id: args.id });
      return `[Bifrost #${entry.id}] (${entry.label}):\n\n${entry.content}`;
    }
    case 'list_tasks': {
      const result = await apiCall('/list-tasks', {});
      if (result.tasks.length === 0) return 'No active Bifrost tasks.';
      return result.tasks.map((t) =>
        `- ${t.name} [${t.status}] (branch: ${t.branch}, id: ${t.id})`
      ).join('\n');
    }
    case 'get_task_diff': {
      const result = await apiCall('/get-task-diff', { taskId: args.taskId, callerTaskId: TASK_ID });
      return result.diff || '(no changes)';
    }
    case 'get_activity_log': {
      const result = await apiCall('/get-activity-log', {
        taskId: args.taskId, callerTaskId: TASK_ID, limit: args.limit || 50,
      });
      if (result.entries.length === 0) return 'No recent activity.';
      return result.entries.map((e) => {
        if (e.type === 'commit') return `[commit] ${e.commitMessage} (${e.commitSha?.slice(0, 7)})`;
        if (e.type === 'file_change') return `[file] ${e.filePath}`;
        if (e.type === 'claude_event') {
          if (e.claudeEventKind === 'tool_use') return `[claude:tool] ${e.claudeToolName}: ${e.claudeText || ''}`;
          return `[claude:${e.claudeEventKind}] ${(e.claudeText || '').slice(0, 200)}`;
        }
        return `[${e.type}]`;
      }).join('\n');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC 2.0 over stdio
let buffer = '';

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'bifrost', version: '1.0.0' },
        },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;

    case 'tools/call':
      handleToolCall(params.name, params.arguments || {})
        .then((text) => {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        })
        .catch((err) => {
          send({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
          });
        });
      break;

    default:
      if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
  }
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }

    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);

    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      // Ignore malformed messages
    }
  }
});

process.stdin.on('end', () => process.exit(0));
