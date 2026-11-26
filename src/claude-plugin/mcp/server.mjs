#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readEpicTemplates } from './epic-templates.mjs';

// ---------------------------------------------------------------------------
// Bifrost API access
// ---------------------------------------------------------------------------

function readPort(file) {
  try {
    return Number(fs.readFileSync(path.join(os.homedir(), '.bifrost', file), 'utf-8').trim());
  } catch {
    return null;
  }
}

function getApiPort() {
  if (process.env.BIFROST_API_PORT) return Number(process.env.BIFROST_API_PORT);
  return readPort('api-port');
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
// MCP Server
// ---------------------------------------------------------------------------

/** The machine this session runs on, by its name in Bifrost's settings. Empty on the machine Bifrost runs on. */
const MACHINE = process.env.BIFROST_MACHINE || '';

/** Whether the API here is this machine's own Bifrost instance. Only an instance writes instance-port. */
const OWN_INSTANCE = MACHINE !== '' && getApiPort() === readPort('instance-port');

/** What to show in place of a task's session name, or null when that name is how to reach it. */
function addressOf(t, unreachedHint) {
  if ((t.machine || '') !== MACHINE) {
    return `on ${t.machine || "Bifrost's own machine"}, out of SendMessage's reach: message_task reaches it by id`;
  }
  if (t.agent && t.agent !== 'claude') {
    return `a ${t.agent} session, out of SendMessage's reach: message_task reaches it by id`;
  }
  return t.sessionName ? null : unreachedHint;
}

/** The agent this session runs, which Bifrost names only for agents other than Claude. */
const AGENT = process.env.BIFROST_AGENT || 'claude';

const CLAUDE_MESSAGING = [
  'Bifrost runs each task as its own Claude Code session in its own git worktree.',
  '',
  'To talk to another task, use the built-in SendMessage tool, not a Bifrost tool.',
  "It delivers into the recipient's turn, and a reply comes back by copying the",
  'incoming `from` attribute as your `to`. Find the recipient with ListAgents.',
  '',
  'A task Bifrost has not opened yet has no session, so it is absent from',
  'ListAgents and cannot be messaged. Call wake_task first: it starts the',
  'session and reports how to address it. A task that is archived or stopped',
  'has to be reopened instead, which is open_task. list_tasks shows every task,',
  'so it is where to look when ListAgents does not list the one you want.',
  '',
  'A session is named after its task as of when the session started, so a task',
  'renamed since then is addressed by its former name. list_tasks, find_task and',
  'wake_task all report the name a task is actually reachable by.',
  '',
  'SendMessage reaches only tasks on the machine you run on, which is',
  MACHINE ? `"${MACHINE}", not the one Bifrost runs on.` : 'the one Bifrost runs on.',
  'list_tasks and find_task name the machine of a task that runs elsewhere.',
  'To reach such a task, use message_task with its task id.',
  '',
  'A message that arrived through message_task begins "From task" and names the',
  "sender's task id. Reply with message_task to that id, not with SendMessage:",
  'the `from` such a message shows is a courier that has already exited.',
];

// The tool descriptions below speak of SendMessage and ListAgents, which only Claude has.
const OTHER_MESSAGING = [
  'Bifrost runs each task as its own agent session in its own git worktree.',
  '',
  'This session has no SendMessage or ListAgents, whatever a tool description',
  'below says. To reach another task, use message_task with its task id, which',
  'list_tasks and find_task report. It tells the recipient who sent it and how',
  'to reply, and a message that reaches you the same way is answered with',
  'message_task to the task id it names. A task that is archived or stopped is',
  'reopened with open_task.',
];

const server = new McpServer(
  {
    name: 'bifrost',
    version: '1.0.0',
  },
  {
    instructions: [
      ...(AGENT === 'claude' ? CLAUDE_MESSAGING : OTHER_MESSAGING),
      '',
      'For a goal that needs several task sessions, use list_epic_templates to find a workflow and create_epic to start its coordinator.',
      'Use message_task for epic coordination and get_epic to recover its recorded progress.',
    ].join('\n'),
  },
);

server.registerTool(
  'list_tasks',
  {
    title: 'List Tasks',
    description:
      'List Bifrost tasks with their status, branch, and worktree path. This is where to look for a task to message: rows with a "send to" show the name to give the built-in SendMessage tool, and rows without one have no session yet — wake_task starts it. There are thousands of tasks, so narrow with query and repo rather than listing everything; newest come first and the rest are cut at limit. To identify one task you already have a handle for, find_task is cheaper.',
    inputSchema: {
      status: z
        .enum(['open', 'running', 'all'])
        .optional()
        .describe(
          'Filter by task status. "open" (default) excludes archived; "running" only live tasks; "all" includes archived.',
        ),
      query: z
        .string()
        .optional()
        .describe(
          'Match against task name, branch, worktree path, session name and repo. Space-separated terms all have to match.',
        ),
      repo: z.string().optional().describe('Only tasks in repos whose name, GitHub path or directory contains this.'),
      limit: z.number().optional().describe('How many to return, newest first (default 50, max 500).'),
    },
  },
  async ({ status, query, repo, limit }) => {
    const result = await apiCall('/list-tasks', { status: status ?? 'open', query, repo, limit });
    const text =
      result.tasks.length > 0
        ? result.tasks
            .map((t) => {
              const display = t.idle === false ? 'working' : t.idle === true ? 'idle' : t.status;
              const reach = t.status === 'running' ? 'wake_task to reach it' : 'open_task to reopen it';
              const address = addressOf(t, `no session — ${reach}`) ?? `send to: "${t.sessionName}"`;
              return `- ${t.name} [${display}] (branch: ${t.branch}, id: ${t.id}, ${address})`;
            })
            .join('\n')
        : 'No matching Bifrost tasks.';
    const note = result.truncated
      ? `\n\n${result.tasks.length} of ${result.total} shown — narrow with query/repo, or raise limit.`
      : '';
    return { content: [{ type: 'text', text: text + note }] };
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

/** A machine as list_machines and add_machine report it. */
function describeMachine(m) {
  const traits = [m.instance && 'its own Bifrost instance', m.sync && 'setup synced', m.agent && `runs ${m.agent}`];
  return `${m.name} (${m.host}${traits
    .filter(Boolean)
    .map((t) => `, ${t}`)
    .join('')})`;
}

server.registerTool(
  'list_machines',
  {
    title: 'List Machines',
    description:
      "List the machines Bifrost runs tasks on besides its own, by the name create_task's machine takes and the ssh host it connects to.",
    inputSchema: {},
  },
  async () => {
    const { machines } = await apiCall('/machines', {});
    const text = machines.length > 0 ? machines.map(describeMachine).join('\n') : 'No machines configured.';
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'add_machine',
  {
    title: 'Add Machine',
    description:
      "Add a machine for Bifrost to run tasks on, reached with plain `ssh <host>` as ~/.ssh/config says. It starts without its setup synced and without an instance of its own, which the user can turn on in Bifrost's settings. A host already configured is answered with its entry.",
    inputSchema: {
      host: z.string().describe("The host ssh connects to, e.g. 'gpu-box.coder'"),
      name: z
        .string()
        .optional()
        .describe("What Bifrost and create_task call it. Omitted, the host's first label, e.g. 'gpu-box'."),
    },
  },
  async ({ host, name }) => {
    const { machine } = await apiCall('/add-machine', { host, name });
    return { content: [{ type: 'text', text: `Machine: ${describeMachine(machine)}` }] };
  },
);

server.registerTool(
  'remove_machine',
  {
    title: 'Remove Machine',
    description:
      'Remove a machine from Bifrost, by name. Refused while a task that is not archived runs there. Nothing on the machine itself is touched.',
    inputSchema: {
      name: z.string().describe('The machine, by its name in list_machines'),
    },
  },
  async ({ name }) => {
    await apiCall('/remove-machine', { name });
    return { content: [{ type: 'text', text: `Removed machine ${name}.` }] };
  },
);

server.registerTool(
  'open_tmux_session',
  {
    title: 'Open tmux Session',
    description:
      "Open a tmux session something else started on one of Bifrost's machines as a task, whose tab in Bifrost joins it to show it and take typing. Bifrost never starts, restarts or ends that session: closing or archiving the task only lets go of it. A session already open as a task is answered with that task, which a directory given moves there. To find one, run `tmux -S <socket> ls` on the machine for each socket in /tmp/tmux-$(id -u)/ (Bifrost's own is named bifrost), and `tmux -S <socket> display-message -p -t <session> '#{pane_current_command} #{pane_current_path}'` to see what runs in it. A machine not yet in list_machines is added with add_machine first.",
    inputSchema: {
      machine: z.string().describe("The machine, by its name in list_machines, e.g. 'gpu-box'"),
      socket: z
        .string()
        .describe(
          "The tmux server: the name `tmux -L` takes, e.g. 'devpod', or the path of its socket, e.g. '/tmp/tmux-1001/devpod'",
        ),
      session: z.string().describe("The tmux session's name, e.g. 'chat'"),
      name: z.string().optional().describe('The task\'s title. Omitted, "<session> on <machine>".'),
      agent: z
        .enum(['claude', 'codex', 'copilot'])
        .optional()
        .describe('The coding agent running in the session, when it is one.'),
      directory: z
        .string()
        .optional()
        .describe(
          "The directory on the machine whose changes the task's diff shows, such as the repo the session's agent edits, e.g. '~/work/my-recipes'. Omitted, the repo the agent runs in, else the directory it runs in.",
        ),
    },
  },
  async ({ machine, socket, session, name, agent, directory }) => {
    const task = await apiCall(
      '/adopt-session',
      { machine, socket, session, name, agent, directory },
      { timeout: 120000 },
    );
    const text = `Task "${task.name}" (${task.id}) shows tmux session "${session}" on ${machine}, in ${task.worktreePath}.`;
    return { content: [{ type: 'text', text }] };
  },
);

const taskTarget = {
  name: z.string().optional().describe('Short title shown in the task list.'),
  repo: z
    .string()
    .optional()
    .describe(
      "The repo name, GitHub slug, or absolute path. Use the slug if more than one repo has the name. Defaults to the calling task's repo.",
    ),
  worktree: z
    .string()
    .optional()
    .describe(
      'Path to an existing worktree on the machine Bifrost runs on. This selects the repo and carries along its branch and uncommitted changes. Archiving removes a task worktree and keeps its branch. A primary checkout stays in place.',
    ),
  machine: z
    .string()
    .optional()
    .describe(
      `${
        OWN_INSTANCE
          ? `Omitted or 'local', the task runs on this machine, "${MACHINE}". 'ide' is the machine Bifrost's window runs on while it is connected. Other names come from list_machines.`
          : 'Choose a machine by name from list_machines. Omitted, the task runs on the machine Bifrost runs on.'
      } A task on another machine starts from a fresh worktree. Reserve the worktree option for tasks on this instance. Use message_task across machines.`,
    ),
  agent: z
    .enum(['claude', 'codex', 'copilot'])
    .optional()
    .describe(
      "The agent the task runs, defaulting to this session's agent. The task keeps its choice when machine defaults change.",
    ),
  model: z.string().optional().describe("Model as the chosen agent's --model flag names it."),
  effort: z.string().optional().describe('Reasoning effort as the chosen agent names it.'),
};

server.registerTool(
  'create_task',
  {
    title: 'Create Task',
    description:
      'Start a task session in a git worktree. From an epic, include the epic and work-item IDs in the prompt and use message_task to coordinate.',
    inputSchema: {
      ...taskTarget,
      prompt: z
        .string()
        .describe(
          "The prompt for the new task's session. Carry what only this session knows: the objective, the decisions taken and why, what was ruled out, what the user actually asked for. Point at everything else rather than transcribing it — file paths, issue and PR numbers, branch names, failing run ids — and say what to look for in each. The new task has its own tools and a fresh context window, so it reads a source faster than you can paraphrase one, and your paraphrase is the lossy copy. Unless you pass 'worktree', it starts from a fresh worktree on the repo's default branch, so a pointer only helps if it resolves there: absolute paths, or a branch it can check out. Write it from what you already have: researching it with file reads and commands spends your context to fill one that is empty anyway. Hand over what you would have looked up, and mark what you did not check as unverified.",
        ),
      wait: z
        .boolean()
        .optional()
        .describe('Wait for creation and return the task ID. The default returns while creation is in progress.'),
    },
  },
  createTask,
);

async function createTask({ name, repo, worktree, machine: asked, prompt, agent, model, effort, wait = false, epic }) {
  // A session names its own host when the IDE serves its API.
  const machine = asked === 'local' ? MACHINE || undefined : asked;
  let repoId;
  const repoPath = worktree ? undefined : repo;

  if (TASK_ID && !repoPath && !worktree) {
    const caller = await apiCall('/find-task', { query: TASK_ID });
    if (caller.ok) {
      repoId = caller.task.repoId;
    }
  }

  if (!repoId && !repoPath && !worktree) {
    return {
      content: [
        {
          type: 'text',
          text: "No repo specified. Provide a 'repo' path or a 'worktree' path, or run inside a Bifrost task.",
        },
      ],
      isError: true,
    };
  }

  const result = await apiCall(
    '/create-task',
    {
      repoId,
      repoPath,
      worktreePath: worktree,
      name,
      prompt,
      machine,
      createdByTaskId: TASK_ID || undefined,
      callerContext: process.env.BIFROST_CONTEXT,
      launch: { agent: agent ?? AGENT, model, effort },
      async: !wait,
      epic,
    },
    wait ? { timeout: 0 } : undefined,
  );
  const taskName = name || 'new task';
  const type = epic ? 'Epic' : 'Task';
  return {
    content: [
      {
        type: 'text',
        text: result.pending
          ? `${type} "${taskName}" is being created${machine ? ` on ${machine}` : ''} and will appear in a new Bifrost tab shortly.${
              (TASK_ID && !MACHINE) || process.env.BIFROST_CONTEXT === 'console'
                ? ' If it cannot be created, a message from Bifrost will say why.'
                : ''
            }`
          : `${type} "${result.name}" created (id: ${result.id}, branch: ${result.branch}). It's running in a new tab.`,
      },
    ],
  };
}

const pluginDir = fileURLToPath(new URL('..', import.meta.url));
const nonBlank = z.string().trim().min(1);

server.registerTool(
  'list_epic_templates',
  {
    title: 'List Epic Templates',
    description: 'Read the built-in workflow templates. Returns each template ID, title, and prompt text.',
    inputSchema: {},
  },
  () => ({ content: [{ type: 'text', text: JSON.stringify(readEpicTemplates(pluginDir), null, 2) }] }),
);

server.registerTool(
  'create_epic',
  {
    title: 'Create Epic',
    description:
      'Start one coordinator task for a goal and a plain-text workflow, then return its task ID. Its session creates the workers.',
    inputSchema: {
      ...taskTarget,
      goal: nonBlank.describe('The outcome the epic should work toward.'),
      template_id: nonBlank.optional().describe('A template ID from list_epic_templates. Supply an ID or inline text.'),
      template_text: z.string().optional().describe('The exact workflow text for a custom or adapted template.'),
    },
  },
  ({ goal, template_id: templateId, template_text: inlineText, ...task }) => {
    if ((templateId === undefined) === (inlineText === undefined)) {
      throw new Error('Supply exactly one of template_id and template_text');
    }
    const template =
      templateId === undefined
        ? inlineText
        : readEpicTemplates(pluginDir).find((entry) => entry.id === templateId)?.text;
    if (!template?.trim()) {
      throw new Error(
        templateId
          ? `Unknown epic template "${templateId}". Run list_epic_templates for the IDs.`
          : 'Template text is empty',
      );
    }
    const name = task.name ?? goal.split(/\r?\n/, 1)[0].slice(0, 50);
    return createTask({ ...task, name, epic: { goal, template, templateId }, wait: true });
  },
);

const epicChange = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('item'),
    id: nonBlank,
    title: nonBlank,
    status: z.enum(['open', 'done', 'dropped']),
    taskId: nonBlank.optional(),
    detail: nonBlank.optional(),
  }),
  z.object({
    kind: z.literal('decision'),
    id: nonBlank,
    question: nonBlank.describe(
      'For a user decision, ask a concrete question in plain language and state what approval would change.',
    ),
    status: z.enum(['open', 'awaiting-advice', 'needs-user', 'resolved']),
    itemId: nonBlank.optional(),
    recommendation: nonBlank
      .optional()
      .describe('Give the recommended choice and its practical reason in one short sentence.'),
    options: z.array(nonBlank).optional(),
    advisorTaskId: nonBlank.optional(),
    answer: nonBlank.optional(),
    decidedBy: z.enum(['coordinator', 'user']).optional(),
    reference: nonBlank.optional().describe('The exact outline, revision, or artifact the decision concerns.'),
    rationale: nonBlank.optional().describe('Supporting reasoning and technical evidence.'),
  }),
  z.object({ kind: z.literal('note'), text: nonBlank }),
  z.object({ kind: z.literal('end'), text: nonBlank }),
  z.object({ kind: z.literal('attach'), taskId: nonBlank }),
]);

async function epicCall(endpoint, body, key) {
  const result = await apiCall(endpoint, { ...body, callerTaskId: TASK_ID || undefined });
  if (!result.ok) throw new Error(result.error || 'The epic request failed');
  return { content: [{ type: 'text', text: JSON.stringify(result[key], null, 2) }] };
}

server.registerTool(
  'get_epic',
  {
    title: 'Get Epic',
    description: 'Read an epic’s saved goal, workflow, members, work items, decisions, and results.',
    inputSchema: { taskId: nonBlank.optional().describe('Epic task ID, defaulting to the calling task.') },
  },
  ({ taskId = TASK_ID }) => {
    if (!taskId) throw new Error('Supply an epic task ID');
    return epicCall('/epic/get', { taskId }, 'state');
  },
);

server.registerTool(
  'update_epic',
  {
    title: 'Update Epic',
    description:
      'Record a complete work item or decision, a progress note, the final outcome, or the ID of an existing task to attach. For the coordinating task.',
    inputSchema: { change: epicChange },
  },
  ({ change }) => {
    if (!TASK_ID) throw new Error('Run update_epic in the coordinator task');
    return epicCall('/epic/update', { taskId: TASK_ID, change }, 'update');
  },
);

server.registerTool(
  'report_epic_result',
  {
    title: 'Report Epic Result',
    description:
      'Save a result or blocker for your epic assignment. Reuse the report ID if a submission needs retrying. Send a short message_task after saving so the coordinator can pick it up.',
    inputSchema: {
      epicId: nonBlank.describe("The coordinator's task ID."),
      itemId: nonBlank.describe('The assigned work-item ID.'),
      reportId: nonBlank.describe('A stable ID you choose for this report.'),
      text: nonBlank.describe('Concise outcome or blocker and a reference to the evidence.'),
      revision: nonBlank.optional().describe('The revision or artifact this result concerns.'),
    },
  },
  ({ epicId, ...report }) => {
    if (!TASK_ID) throw new Error('Run report_epic_result in the assigned member task');
    return epicCall('/epic/report', { taskId: epicId, ...report }, 'update');
  },
);

server.registerTool(
  'close_or_archive_task',
  {
    title: 'Close / Archive Task',
    description:
      'Close or archive a Bifrost task. Omit taskId to act on the task you are running in, which is what "this task" means and is the usual case. Close (default) stops sessions and closes the tab but preserves the git worktree. Archive does everything close does plus marks the task as archived and deletes the worktree.',
    inputSchema: {
      taskId: z
        .string()
        .optional()
        .describe(
          'Only for closing a task other than the calling one. The id of the task that created this one belongs to that task, not this one.',
        ),
      archive: z
        .boolean()
        .optional()
        .describe(
          "If true, archive the task: close + mark archived + delete worktree. Defaults to false (close only). Archiving deletes only the task's own worktree. It cannot know what the task created anywhere else, so before archiving the task you run in, remove that yourself: worktrees you added to other repos, clones and scratch directories, processes still running, headroom claims still held. Remove only what this task created, since other sessions share the machine.",
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
  'find_task',
  {
    title: 'Find Task',
    description:
      'Identify the Bifrost task behind something you already have: a task id, a Claude session id, a worktree directory, a branch, a current name, or the name a renamed task used to have. Returns the task and, when its session is running, the name to give the built-in SendMessage tool. Use this to work out who you are talking to, or to turn a directory into a task you can message.',
    inputSchema: {
      query: z
        .string()
        .describe('Task id, session id, worktree path, branch, or task name. Directories may be a prefix.'),
    },
  },
  async ({ query }) => {
    const result = await apiCall('/find-task', { query });
    if (!result.ok) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }
    const t = result.task;
    const lines = [
      `${t.name} (id: ${t.id})`,
      `status: ${t.status}${t.idle === undefined ? '' : t.idle ? ', idle' : ', working'}`,
      `branch: ${t.branch ?? t.baseBranch}`,
      `worktree: ${t.worktreePath}${t.machine ? ` on ${t.machine}` : ''}`,
      addressOf(t, 'no session running — wake_task starts one and reports how to address it') ??
        `send to: "${t.sessionName}" with SendMessage${
          t.sessionName === t.name ? '' : ' (its session name; the task has been renamed since)'
        }`,
    ];
    if (t.createdByTaskId) lines.push(`created by task: ${t.createdByTaskId}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.registerTool(
  'wake_task',
  {
    title: 'Wake Task',
    description:
      "Start a Bifrost task's Claude session if it is not already running, so it becomes reachable by the built-in SendMessage tool. Bifrost starts a task's session only when the task is first opened, and a task with no session does not appear in ListAgents. Returns the name to address it by, which is the name its session carries rather than the task's current name. Only for tasks that are still open; an archived or stopped task is reopened with open_task.",
    inputSchema: {
      taskId: z.string().describe('Task ID, from list_tasks'),
    },
  },
  async ({ taskId }) => {
    const result = await apiCall('/wake-task', { taskId });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Failed to wake task: ${result.error}` }], isError: true };
    }
    const state = result.alreadyAwake ? 'was already running' : 'started';
    const text = `Session ${state}. Address it with SendMessage using to: "${result.name}".`;
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'open_task',
  {
    title: 'Open Task',
    description:
      "Reopen an archived or stopped Bifrost task and start its Claude session, so it becomes reachable by the built-in SendMessage tool. Rebuilds the worktree from the task's branch when archiving removed it, clears the archived state, and returns the name to address the session by. A task that is already open is left alone and its address returned, so this is safe to call without checking status first. Multi-repo tasks cannot be reopened, and neither can external or in-place tasks whose directory is gone.",
    inputSchema: {
      taskId: z.string().describe('Task ID, from list_tasks (use status "all" to see archived ones)'),
    },
  },
  async ({ taskId }) => {
    const result = await apiCall('/open-task', { taskId });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Failed to open task: ${result.error}` }], isError: true };
    }
    const state = result.wasOpen ? 'was already open' : `reopened at ${result.worktreePath}`;
    const text = `Task ${state}. Address it with SendMessage using to: "${result.name}".`;
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
    const sent = result.queued
      ? `Prompt queued for task ${targetId}. It is typed when the task's current turn ends.`
      : `Prompt sent to task ${targetId} (mode: ${mode || 'queue'}).`;
    return { content: [{ type: 'text', text: sent }] };
  },
);

server.registerTool(
  'message_task',
  {
    title: 'Message Task',
    description:
      "Send a message to another Bifrost task by its task id, on this machine or another. It arrives in the recipient's turn headed with your task's name and id, and with how to reply, which is message_task back to you. A Claude session on the machine its instance runs on gets it as a SendMessage, and any other as a queued prompt. Returns once it is delivered or queued. A task with no session yet is started first.",
    inputSchema: {
      taskId: z.string().describe("The recipient's task id, as list_tasks and find_task report it"),
      message: z.string().describe('The message, which arrives verbatim'),
    },
  },
  async ({ taskId, message }) => {
    // A relay run can take most of a minute, and a session that has to start first takes longer.
    const result = await apiCall('/message-task', { taskId, fromTaskId: TASK_ID, text: message }, { timeout: 180000 });
    if (!result.ok) {
      return { content: [{ type: 'text', text: `Not delivered: ${result.error}` }], isError: true };
    }
    const how =
      result.via === 'message'
        ? 'Delivered as a message.'
        : result.queued
          ? "Queued as a prompt. It is typed when the task's current turn ends."
          : 'Delivered as a prompt.';
    return { content: [{ type: 'text', text: `${how} A reply, if it sends one, arrives headed "From task".` }] };
  },
);

// ---------------------------------------------------------------------------
// Agent messaging tools (structured communication with sender identity)
// ---------------------------------------------------------------------------

/** Resolve the calling task's name for message attribution. */
const transport = new StdioServerTransport();
await server.connect(transport);
