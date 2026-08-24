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

function apiCall(endpoint, body, { timeout = 60000 } = {}) {
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
        timeout,
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

const server = new McpServer(
  {
    name: 'bifrost',
    version: '1.0.0',
  },
  {
    instructions: [
      'Bifrost runs each task as its own Claude Code session in its own git worktree.',
      '',
      'To talk to another task, use the built-in SendMessage tool, not a Bifrost tool.',
      "It delivers into the recipient's turn, and a reply comes back by copying the",
      'incoming `from` attribute as your `to`. Find the recipient with ListAgents.',
      '',
      'A task Bifrost has not opened yet has no session, so it is absent from',
      'ListAgents and cannot be messaged. Call wake_task first: it starts the',
      'session and reports how to address it. list_tasks shows every task, so it is',
      'where to look when ListAgents does not list the one you want.',
      '',
      'A session is named after its task as of when the session started, so a task',
      'renamed since then is listed under its former name. Trust ListAgents over the',
      'name you were given.',
    ].join('\n'),
  },
);

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
    description:
      'List Bifrost tasks with their status, branch, and worktree path. By default returns only non-archived tasks (running, stopped, error). Use status="running" to narrow further to live tasks, or status="all" to include archived.',
    inputSchema: {
      status: z
        .enum(['open', 'running', 'all'])
        .optional()
        .describe(
          'Filter by task status. "open" (default) excludes archived; "running" only live tasks; "all" includes archived.',
        ),
    },
  },
  async ({ status }) => {
    const result = await apiCall('/list-tasks', { status: status ?? 'open' });
    const text =
      result.tasks.length > 0
        ? result.tasks
            .map((t) => {
              const display = t.idle === false ? 'working' : t.idle === true ? 'idle' : t.status;
              return `- ${t.name} [${display}] (branch: ${t.branch}, id: ${t.id})`;
            })
            .join('\n')
        : 'No matching Bifrost tasks.';
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
  'add_repo',
  {
    title: 'Add Repo',
    description:
      'Add a local git repository to Bifrost. The path must point to an existing git repo on disk. If the repo is already configured, returns the existing entry.',
    inputSchema: {
      path: z
        .string()
        .describe("Absolute path to the git repository (e.g. '/Users/me/git/my-repo' or '~/git/my-repo')"),
    },
  },
  async ({ path }) => {
    const result = await apiCall('/add-repo', { path });
    const text = `Added repo: ${result.name} (${result.githubPath || result.path}, branch: ${result.defaultBranch})`;
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'create_task',
  {
    title: 'Create Task',
    description:
      'Create a new Bifrost task. Spawns a git worktree and Claude Code session. The new task runs in the background. Works from any Claude Code session — specify repo by path if not running inside a Bifrost task. Called from inside a task, the new one is told who created it and how to reach them, so it can report back with the built-in SendMessage tool; to follow up on it yourself, find it in ListAgents and use SendMessage rather than waiting here.',
    inputSchema: {
      name: z
        .string()
        .optional()
        .describe('Short task title (max ~50 chars, shown in tabs/history). Auto-generated from prompt if omitted.'),
      repo: z
        .string()
        .optional()
        .describe(
          "Path to the git repository (e.g. '~/git/org/repo') or GitHub slug (e.g. 'org/repo'). Required when not running inside a Bifrost task.",
        ),
      prompt: z.string().describe("The prompt/instructions for the new task's Claude session."),
    },
  },
  async ({ name, repo, prompt }) => {
    let repoId;
    let repoPath;
    let callerName;

    if (TASK_ID) {
      const result = await apiCall('/list-tasks', {});
      const callerTask = result.tasks.find((t) => t.id === TASK_ID);
      if (callerTask) {
        repoId = callerTask.repoId;
        callerName = callerTask.name;
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

    // A new task has no way to find whoever asked for it, and its creator is
    // awake by definition. SendMessage addresses by session name, which is the
    // task's name from when its session started rather than its name now, so
    // the id travels too and ListAgents settles which row is meant.
    const withCoordinates = callerName
      ? `${prompt}\n\n---\nThis task was created by the Bifrost task "${callerName}" (id: ${TASK_ID}), which is running and reachable. To report back, ask a question, or hand results over, use the built-in SendMessage tool. Find the recipient in ListAgents first: its session is named after the task, but from when the session started, so a renamed task is listed under its former name.`
      : prompt;

    const result = await apiCall('/create-task', {
      repoId,
      repoPath,
      name,
      prompt: withCoordinates,
      createdByTaskId: TASK_ID || undefined,
      async: true,
    });
    const taskName = name || 'new task';
    return {
      content: [
        {
          type: 'text',
          text: result.pending
            ? `Task "${taskName}" is being created and will appear in a new Bifrost tab shortly.`
            : `Task "${result.name}" created (id: ${result.id}, branch: ${result.branch}). It's running in a new tab.`,
        },
      ],
    };
  },
);

server.registerTool(
  'close_or_archive_task',
  {
    title: 'Close / Archive Task',
    description:
      'Close or archive a Bifrost task. Use this to archive a task when done. Close (default) stops sessions and closes the tab but preserves the git worktree. Archive does everything close does plus marks the task as archived and deletes the worktree.',
    inputSchema: {
      taskId: z.string().optional().describe('Task ID (optional, defaults to calling task)'),
      archive: z
        .boolean()
        .optional()
        .describe(
          'If true, archive the task: close + mark archived + delete worktree. Defaults to false (close only).',
        ),
      force: z
        .boolean()
        .optional()
        .describe('If true, skip the dirty-worktree check when archiving. Ignored when archive is false.'),
    },
  },
  async ({ taskId, archive, force }) => {
    const targetId = taskId || TASK_ID;
    if (!targetId) {
      return {
        content: [{ type: 'text', text: "No task specified. Provide a 'taskId' or run inside a Bifrost task." }],
        isError: true,
      };
    }
    const result = await apiCall('/close-task', {
      taskId: targetId,
      archive: archive || false,
      force: force || false,
    });
    const action = archive ? 'archived' : 'closed';
    return {
      content: [
        {
          type: 'text',
          text: `Task "${result.name}" (${result.id}) ${action}.`,
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// PTY injection tools (raw terminal injection, no identity attribution)
// ---------------------------------------------------------------------------

server.registerTool(
  'ask_prompt',
  {
    title: 'Ask Prompt',
    description:
      'Inject a prompt into a Bifrost task\'s terminal and wait for the response. This is raw PTY injection — the recipient sees it as user input with no sender identity. Blocks until the task\'s turn completes, then returns the assistant\'s reply. WARNING: Can take a long time if the task is busy. Use list_tasks to check status first. Modes: "queue" (default) waits for any active turn to finish, "interrupt" stops current work first, "only-when-idle" fails if busy.',
    inputSchema: {
      taskId: z.string().optional().describe('Task ID (optional, defaults to calling task)'),
      text: z.string().describe('The prompt text to inject'),
      mode: z
        .enum(['queue', 'interrupt', 'only-when-idle'])
        .optional()
        .describe('Send mode (default: queue). "interrupt" stops the task\'s current work first.'),
    },
  },
  async ({ taskId, text, mode }) => {
    const targetId = taskId || TASK_ID;
    if (!targetId) {
      return {
        content: [{ type: 'text', text: "No task specified. Provide a 'taskId' or run inside a Bifrost task." }],
        isError: true,
      };
    }
    const result = await apiCall(
      '/send-prompt',
      {
        taskId: targetId,
        text,
        mode: mode || 'queue',
        waitForTurn: true,
      },
      { timeout: 0 },
    );
    if (!result.ok) {
      return {
        content: [{ type: 'text', text: `Failed: ${result.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: result.response || '(no response text captured)' }],
    };
  },
);

server.registerTool(
  'wake_task',
  {
    title: 'Wake Task',
    description:
      "Start a Bifrost task's Claude session if it is not already running, so it becomes reachable by the built-in SendMessage tool. Bifrost starts a task's session only when the task is first opened, and a task with no session does not appear in ListAgents. Wake it, then address it with SendMessage. A session Bifrost starts is named after the task; one that was already running carries the name the task had when it started, so confirm that one against ListAgents.",
    inputSchema: {
      taskId: z.string().describe('Task ID, from list_tasks'),
    },
  },
  async ({ taskId }) => {
    const result = await apiCall('/wake-task', { taskId });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Failed to wake task: ${result.error}` }], isError: true };
    }
    const text = result.alreadyAwake
      ? `Session was already running, started under whatever the task was called then; the task is called "${result.name}" now. Find it in ListAgents and address it with SendMessage.`
      : `Session started as "${result.name}". Address it with SendMessage using to: "${result.name}".`;
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'send_prompt',
  {
    title: 'Send Prompt',
    description:
      'Inject a prompt into a Bifrost task\'s terminal without waiting for a response. This is raw PTY injection — the recipient sees it as user input with no sender identity. Returns immediately after submitting. Modes: "direct" sends immediately, "queue" (default) waits for current turn to finish, "interrupt" stops current work first, "only-when-idle" fails if busy.',
    inputSchema: {
      taskId: z.string().optional().describe('Task ID (optional, defaults to calling task)'),
      text: z.string().describe('The prompt text to inject'),
      mode: z
        .enum(['direct', 'queue', 'interrupt', 'only-when-idle'])
        .optional()
        .describe('Send mode (default: queue). "interrupt" stops the task\'s current work first.'),
    },
  },
  async ({ taskId, text, mode }) => {
    const targetId = taskId || TASK_ID;
    if (!targetId) {
      return {
        content: [{ type: 'text', text: "No task specified. Provide a 'taskId' or run inside a Bifrost task." }],
        isError: true,
      };
    }
    const result = await apiCall('/send-prompt', {
      taskId: targetId,
      text,
      mode: mode || 'queue',
    });
    if (!result.ok) {
      return {
        content: [{ type: 'text', text: `Failed: ${result.error}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: `Prompt sent to task ${targetId} (mode: ${mode || 'queue'}).` }],
    };
  },
);

// ---------------------------------------------------------------------------
// Agent messaging tools (structured communication with sender identity)
// ---------------------------------------------------------------------------

/** Resolve the calling task's name for message attribution. */
const transport = new StdioServerTransport();
await server.connect(transport);
