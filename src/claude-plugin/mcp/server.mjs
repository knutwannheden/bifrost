#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Bifrost API access
// ---------------------------------------------------------------------------

function getApiPort() {
  if (process.env.BIFROST_API_PORT) return Number(process.env.BIFROST_API_PORT);
  try {
    const portFile = path.join(os.homedir(), '.bifrost', 'api-port');
    return Number(fs.readFileSync(portFile, 'utf-8').trim());
  } catch {
    return null;
  }
}

const TASK_ID = process.env.BIFROST_TASK_ID || null;

function apiCall(endpoint, body) {
  const port = getApiPort();
  if (!port) return Promise.reject(new Error('Bifrost API not running'));

  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: endpoint,
        method: 'POST',
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            const json = JSON.parse(text);
            if (res.statusCode >= 400) reject(new Error(json.error || `HTTP ${res.statusCode}`));
            else resolve(json);
          } catch {
            reject(new Error(`Invalid JSON: ${text}`));
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Context formatting
// ---------------------------------------------------------------------------

function formatContextEntry(entry) {
  const header = `[Bifrost #${entry.id}] (${entry.type}, task: ${entry.taskName})`;

  switch (entry.type) {
    case 'terminal':
      return `${header}:\n\n${entry.content}`;
    case 'diff':
      return `${header}:\n\n${entry.content}`;
    case 'activity':
      return `${header}:\n\n${entry.content}`;
    case 'transcript': {
      // resolvedContent from JSONL > selectedText > captured terminal text
      const content = entry.resolvedContent || entry.selectedText || entry.content || '(no content)';
      const selection = entry.selectedText && entry.resolvedContent ? `\n\nSelected text: ${entry.selectedText}` : '';
      return `${header} [from Claude session JSONL]:\n\n${content}${selection}`;
    }
    default:
      return `${header}:\n\n${entry.content || '(no content)'}`;
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'bifrost',
  version: '1.0.0',
});

server.registerTool(
  'resolve_context',
  {
    title: 'Resolve Context',
    description:
      'Resolve a Bifrost context reference [Bifrost #N] to its content. Use when user messages contain [Bifrost #N] patterns.',
    inputSchema: {
      id: z.number().describe('The context reference number N from [Bifrost #N]'),
    },
  },
  async ({ id }) => {
    const entry = await apiCall('/resolve-context', { id });
    return {
      content: [
        {
          type: 'text',
          text: formatContextEntry(entry),
        },
      ],
    };
  },
);

server.registerTool(
  'list_tasks',
  {
    title: 'List Tasks',
    description: 'List all Bifrost tasks with their status, branch, and worktree path.',
    inputSchema: {},
  },
  async () => {
    const result = await apiCall('/list-tasks', {});
    const text =
      result.tasks.length > 0
        ? result.tasks.map((t) => `- ${t.name} [${t.status}] (branch: ${t.branch}, id: ${t.id})`).join('\n')
        : 'No active Bifrost tasks.';
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'get_task_diff',
  {
    title: 'Get Task Diff',
    description: 'Get the git diff for a Bifrost task. Defaults to the calling task if no taskId specified.',
    inputSchema: {
      taskId: z.string().optional().describe('Task ID (optional, defaults to calling task)'),
    },
  },
  async ({ taskId }) => {
    const result = await apiCall('/get-task-diff', {
      taskId,
      callerTaskId: TASK_ID,
    });
    return {
      content: [{ type: 'text', text: result.diff || '(no changes)' }],
    };
  },
);

server.registerTool(
  'get_activity_log',
  {
    title: 'Get Activity Log',
    description: 'Get recent activity entries (file changes, commits, Claude events) for a Bifrost task.',
    inputSchema: {
      taskId: z.string().optional().describe('Task ID (optional, defaults to calling task)'),
      limit: z.number().optional().describe('Max entries to return (default 50)'),
    },
  },
  async ({ taskId, limit }) => {
    const result = await apiCall('/get-activity-log', {
      taskId,
      callerTaskId: TASK_ID,
      limit: limit || 50,
    });
    if (result.entries.length === 0) {
      return { content: [{ type: 'text', text: 'No recent activity.' }] };
    }
    const text = result.entries
      .map((e) => {
        if (e.type === 'commit') return `[commit] ${e.commitMessage} (${e.commitSha?.slice(0, 7)})`;
        if (e.type === 'file_change') return `[file] ${e.filePath}`;
        if (e.type === 'claude_event') {
          if (e.claudeEventKind === 'tool_use') return `[claude:tool] ${e.claudeToolName}: ${e.claudeText || ''}`;
          return `[claude:${e.claudeEventKind}] ${(e.claudeText || '').slice(0, 200)}`;
        }
        return `[${e.type}]`;
      })
      .join('\n');
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'list_notes',
  {
    title: 'List Notes',
    description: "List all project notes for the current Bifrost task's repository.",
    inputSchema: {},
  },
  async () => {
    const result = await apiCall('/list-notes', { callerTaskId: TASK_ID });
    if (result.notes.length === 0) {
      return { content: [{ type: 'text', text: 'No notes.' }] };
    }
    const text = result.notes
      .map((n) => `- ${n.text} (id: ${n.id}, ${new Date(n.createdAt).toLocaleString()})`)
      .join('\n');
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'delete_note',
  {
    title: 'Delete Note',
    description: 'Delete a project note by its ID.',
    inputSchema: {
      noteId: z.string().describe('The note ID to delete'),
    },
  },
  async ({ noteId }) => {
    await apiCall('/delete-note', { callerTaskId: TASK_ID, noteId });
    return {
      content: [{ type: 'text', text: `Note ${noteId} deleted.` }],
    };
  },
);

server.registerTool(
  'get_handoff',
  {
    title: 'Get Handoff',
    description:
      "Read a handoff document from a Bifrost task. Returns the markdown content written by another session's /handoff command.",
    inputSchema: {
      taskId: z.string().describe('The task ID to read the handoff from'),
    },
  },
  async ({ taskId }) => {
    const handoffPath = path.join(os.homedir(), '.bifrost', 'tasks', taskId, 'handoff.md');
    try {
      const content = fs.readFileSync(handoffPath, 'utf-8');
      return { content: [{ type: 'text', text: content }] };
    } catch {
      return {
        content: [{ type: 'text', text: `No handoff found for task ${taskId}.` }],
      };
    }
  },
);

server.registerTool(
  'list_repos',
  {
    title: 'List Repos',
    description: 'List all repositories configured in Bifrost with their paths and default branches.',
    inputSchema: {},
  },
  async () => {
    const result = await apiCall('/list-repos', {});
    const text =
      result.repos.length > 0
        ? result.repos.map((r) => `- ${r.name} (${r.githubPath || r.path}, branch: ${r.defaultBranch})`).join('\n')
        : 'No repos configured in Bifrost.';
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'create_task',
  {
    title: 'Create Task',
    description:
      'Create a new Bifrost task. Spawns a git worktree and Claude Code session. The new task runs in the background. Works from any Claude Code session — specify repo by path if not running inside a Bifrost task.',
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe(
          'Human-readable task description (shown in tooltips/history). Auto-generated from prompt if omitted.',
        ),
      repo: z
        .string()
        .optional()
        .describe(
          "Path to the git repository (e.g. '~/git/org/repo') or GitHub slug (e.g. 'org/repo'). Required when not running inside a Bifrost task.",
        ),
      prompt: z.string().optional().describe("Initial prompt/instructions for the new task's Claude session"),
      branch: z
        .string()
        .optional()
        .describe(
          "Desired git branch name for the new worktree (e.g. 'fix-auth-bug'). Auto-derived from task name if omitted.",
        ),
    },
  },
  async ({ name, repo, prompt, branch }) => {
    let repoId;
    let repoPath;
    let defaultBranch;

    if (TASK_ID) {
      const result = await apiCall('/list-tasks', {});
      const callerTask = result.tasks.find((t) => t.id === TASK_ID);
      if (callerTask) {
        repoId = callerTask.repoId;
        defaultBranch = callerTask.branch;
      }
    }

    // Explicit repo path overrides caller task's repo
    if (repo) {
      repoId = undefined;
      repoPath = repo;
    }

    if (!repoId && !repoPath) {
      return {
        content: [{ type: 'text', text: "No repo specified. Provide a 'repo' path or run inside a Bifrost task." }],
        isError: true,
      };
    }

    const task = await apiCall('/create-task', {
      repoId,
      repoPath,
      name,
      branch: defaultBranch || 'main',
      branchName: branch || undefined,
      prompt,
    });
    return {
      content: [
        {
          type: 'text',
          text: `Task "${task.name}" created (id: ${task.id}, branch: ${task.branch}). It's running in a new tab.`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
