import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BifrostConfig, Repo, Task } from '../shared/types';

const execFile = promisify(execFileCb);

import { IPC_STREAM, type IpcChannel } from '../shared/ipc-channels';
import {
  forgetTask,
  subagentStarted,
  subagentStopped,
  subagentsRunning,
  sweepHeldTurns,
  turnEnded,
} from './activity-state';
import { getActivityLog, stopWatching } from './activity-watcher';
import { relayMessage } from './claude-oneshot';
import { loadConfig, saveConfig } from './config';
import { CONSOLE_NAME, CONSOLE_SESSION_ID } from './console-service';
import { getDiff } from './diff-service';
import { BELL, emit, listening, subscribe } from './event-sink';
import { calls } from './ipc-calls';
import { deleteNote, listNotes } from './note-store';
import { forwardTaskRoute, peerTasks } from './peers';
import { cancelTaskRequests, checkExistingRules, createRequest } from './permission-manager';
import { markPrIndexStale } from './pr-index';
import { isIdle, markActive, markIdle, sendPrompt as sendPromptToTask, workingTaskIds } from './prompt-sender';
import { getRemoteHost, sessionIdScript } from './remote-host';
import { addRepo } from './repo-manager';
import { normalizeRepoPath } from './repo-path';
import {
  getSessionName,
  hasSession,
  killSession,
  sessionAwaitsTrust,
  sessionOutputAt,
  waitForSessionReady,
} from './session-manager';
import {
  archiveTaskCore,
  createTaskCore,
  getRemoteDiff,
  getTask,
  getTasks,
  importTasks,
  isPendingRestore,
  isRemoteWorktreeDirty,
  markTurnBoundary,
  reopenTaskCore,
  resolveTaskTarget,
  restoreTaskSession,
  stopTaskSession,
  type TaskTarget,
  transferTaskCore,
  updateTask,
} from './task-service';
import { writeLocalSessionId } from './tmux-session';

const BELL_DEBOUNCE_MS = 10_000;
const lastBell = new Map<string, number>();

/** Rings unless the key rang within BELL_DEBOUNCE_MS, and answers whether it did. */
function ringBell(key: string, name: string): boolean {
  const now = Date.now();
  if (now - (lastBell.get(key) ?? 0) < BELL_DEBOUNCE_MS) return false;
  lastBell.set(key, now);
  emit(BELL, name);
  return true;
}

/**
 * Check if a Claude session is still valid.
 * Claude encodes project paths by replacing `/` and `.` with `-` in ~/.claude/projects.
 * Session files are stored as {sessionId}.jsonl in the project directory.
 */
export function isSessionStale(worktreePath: string, sessionId?: string): boolean {
  const encoded = worktreePath.replace(/[/.]/g, '-');
  const projectPath = path.join(os.homedir(), '.claude', 'projects', encoded);

  // Project directory doesn't exist = definitely stale
  if (!fs.existsSync(projectPath)) {
    return true;
  }

  // If sessionId provided, check if that specific session file exists and has content
  if (sessionId) {
    const sessionFilePath = path.join(projectPath, `${sessionId}.jsonl`);
    try {
      const stat = fs.statSync(sessionFilePath);
      // Files under 4 KB typically contain only metadata (file-history-snapshot,
      // progress entries) with no actual conversation — Claude cannot resume these.
      return stat.size < 4096;
    } catch {
      return true;
    }
  }

  // Project exists but no sessionId provided, so we can't confirm it's valid
  return false;
}

export function initApi(): void {
  setInterval(sweepStaleWork, SWEEP_MS).unref();
}

const SWEEP_MS = 15_000;
// Claude redraws an elapsed-time counter for as long as it is working, so a
// session that has written nothing for this long is not working, whatever the
// hooks last said. Well clear of a slow redraw, well under a coffee break.
const SILENT_MS = 45_000;

/**
 * A missed hook leaves a task pulsing green with nothing to correct it — a turn
 * ended while Bifrost was restarting, a curl timed out, a session was killed.
 * The session's own output settles the question independently of any of that. A task holding
 * subagents open is exempt: Bifrost has its own record of that work, so silence
 * does not settle anything.
 */
function sweepStaleWork(): void {
  const now = Date.now();
  for (const taskId of sweepHeldTurns(now)) {
    try {
      finishTurn(getTask(taskId));
    } catch {
      /* the task is gone, and with it the turn to finish */
    }
  }
  for (const taskId of workingTaskIds()) {
    if (subagentsRunning(taskId, now)) continue;
    const at = sessionOutputAt(taskId);
    if (at != null && now - at < SILENT_MS) continue;
    markIdle(taskId);
    emit(IPC_STREAM.CLAUDE_ACTIVE, taskId, false);
  }
}

const PORT_START = 7623;
const PORT_END = 7632;
const PORT_FILE = path.join(os.homedir(), '.bifrost', 'api-port');

let server: http.Server | null = null;
let activePort: number | null = null;

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function errorResponse(res: http.ServerResponse, message: string, status = 400): void {
  jsonResponse(res, { error: message }, status);
}

function notStartedReason(taskId: string): string {
  return sessionAwaitsTrust(taskId)
    ? "Session is stopped on Claude Code's workspace trust prompt. Answer it in the task's tab."
    : 'Session did not finish starting up';
}

function resolveTaskId(body: Record<string, unknown>): string | undefined {
  return (body.taskId as string) || (body.callerTaskId as string) || undefined;
}

/**
 * Kill both of a task's sessions: the main one and its dev terminal. Uses
 * deterministic session IDs so we don't need the in-memory Maps from ipc-handlers.
 */
/**
 * Tools that hand the turn to the user. Claude Code's own notification for
 * these is scheduled on a delay, so a question answered promptly never raises
 * one and the task would sit green as though it were still working.
 */
const WAITS_FOR_USER = new Set(['AskUserQuestion', 'ExitPlanMode']);

/** Claude has stopped and wants something: idle, ordered, and the row turned. */
function awaitUser(task: Task): void {
  if (turnEnded(task.id)) {
    markIdle(task.id);
    turnBoundary(task.id);
    emit(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
  }
  if (!ringBell(task.id, task.name)) return;
  emit(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, '', '', 'question');
}

/**
 * The task a hook came from. Its id travels in the session's environment and is
 * exact; a cwd only says where the agent is standing, and it follows the agent
 * into subdirectories. The deepest worktree containing the path owns it, since
 * a repo worked on in place contains the worktrees of every other task in it.
 */
function hookTask(body: Record<string, unknown>): Task | undefined {
  const taskId = body.bifrost_task_id as string | undefined;
  if (taskId) {
    const byId = getTasks().find((t) => t.id === taskId && t.status !== 'archived');
    if (byId) return byId;
  }
  const cwd = (body.cwd as string) ?? '';
  let deepest: Task | undefined;
  for (const t of getTasks()) {
    if (t.status !== 'running') continue;
    if (cwd !== t.worktreePath && !cwd.startsWith(`${t.worktreePath}/`)) continue;
    if (!deepest || t.worktreePath.length > deepest.worktreePath.length) deepest = t;
  }
  return deepest;
}

/** The sidebar orders by these, so the writes inside a turn leave rows put. */
function turnBoundary(taskId: string): void {
  const at = Date.now();
  markTurnBoundary(taskId, at);
  emit(IPC_STREAM.TASK_TURN_BOUNDARY, taskId, at);
}

/** The end of a task's work: idle, notified, and the sidebar's bar turned. */
function finishTurn(task: Task): void {
  turnBoundary(task.id);
  forgetTask(task.id);
  markIdle(task.id);
  // A turn that just ended is the likeliest moment for a PR to exist.
  markPrIndexStale(task.repoId);
  emit(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
  ringBell(task.id, task.name);
}

/**
 * Tells the session that asked for a task why it was not created, since it was
 * answered before the work ran. A caller SendMessage cannot reach, on another
 * machine or outside Bifrost, has the toast alone.
 */
function reportCreateFailure(
  params: { name?: string; machine?: string; createdByTaskId?: string },
  fromConsole: boolean,
  repoName: string,
  reason: string,
): void {
  let to: string | undefined;
  if (params.createdByTaskId) {
    const creator = getTasks().find((t) => t.id === params.createdByTaskId);
    to = creator && !creator.machine ? getSessionName(creator.id) : undefined;
  } else if (fromConsole && hasSession(CONSOLE_SESSION_ID)) {
    to = CONSOLE_NAME;
  }
  if (!to) return;
  const what = params.name ? `Task "${params.name}"` : 'The task you asked for';
  const where = params.machine ? ` on ${params.machine}` : '';
  relayMessage(
    to,
    `${what} in ${repoName} was not created${where}: ${reason}\n\nBifrost sent this and cannot read a reply.`,
  ).catch((err) => console.warn('[api] could not report the failed task:', err));
}

function killTaskSessions(task: Task): void {
  stopTaskSession(task);
  killSession(`${task.id}-dev`);
}

/** The routes that act on one task, named by the request. */
const FORWARDED_ROUTES = new Set([
  '/close-task',
  '/get-task-diff',
  '/get-activity-log',
  '/wake-task',
  '/open-task',
  '/send-prompt',
  '/list-notes',
  '/delete-note',
]);

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    errorResponse(res, 'Method not allowed', 405);
    return;
  }

  const body = await readJsonBody(req);

  // A request about a task another instance owns is answered by that instance.
  if (req.url && FORWARDED_ROUTES.has(req.url)) {
    try {
      const answer = await forwardTaskRoute(req.url, body);
      if (answer) {
        jsonResponse(res, answer);
        return;
      }
    } catch (err) {
      errorResponse(res, (err as Error).message, 502);
      return;
    }
  }

  switch (req.url) {
    case '/call': {
      const { channel, args = [] } = body as { channel?: IpcChannel; args?: unknown[] };
      const call = channel ? calls[channel] : undefined;
      if (!call) {
        errorResponse(res, `No call ${channel}`, 404);
        return;
      }
      try {
        jsonResponse(res, { result: await call(...args) });
      } catch (e) {
        errorResponse(res, (e as Error).message, 500);
      }
      return;
    }

    // Held open, one event per line, of this instance's own events. The terminals belong to whoever
    // attached to them, and an event relayed from another instance would echo between the two.
    case '/events': {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.flushHeaders();
      const leave = subscribe((channel, args, origin) => {
        if (origin !== undefined || channel === IPC_STREAM.SESSION_DATA || channel === IPC_STREAM.SESSION_EXIT) return;
        res.write(`${JSON.stringify({ channel, args })}\n`);
      });
      res.on('close', leave);
      return;
    }

    // What the IDE copies to an instance on another machine, so its sessions start as the IDE's do.
    case '/preferences': {
      const config = loadConfig() as unknown as Record<string, unknown>;
      for (const key of ['permissionMode', 'agentTeams', 'managePermissions', 'prompts', 'remoteControlAtStartup']) {
        if (key in body) config[key] = body[key];
      }
      saveConfig(config as unknown as BifrostConfig);
      jsonResponse(res, { ok: true });
      return;
    }

    // Tasks another instance hands this one. The sender forgets them once this answers.
    case '/import-tasks': {
      const { tasks: handed = [], repos = [] } = body as { tasks?: Task[]; repos?: Repo[] };
      jsonResponse(res, { ids: importTasks(handed, repos) });
      return;
    }

    case '/list-repos': {
      const config = loadConfig();
      const repos = config.repos.map(
        (r: { id: string; name: string; path: string; defaultBranch: string; githubPath?: string }) => ({
          id: r.id,
          name: r.name,
          path: r.path,
          defaultBranch: r.defaultBranch,
          githubPath: r.githubPath,
        }),
      );
      jsonResponse(res, { repos });
      return;
    }

    case '/add-repo': {
      const repoPath = body.path as string;
      if (!repoPath) {
        errorResponse(res, 'path is required');
        return;
      }
      try {
        const config = loadConfig();
        const existing = config.repos.find((r: { path: string }) => r.path === normalizeRepoPath(repoPath));
        if (existing) {
          jsonResponse(res, existing);
          return;
        }
        const repo = await addRepo({ type: 'local', path: repoPath });
        config.repos.push(repo);
        saveConfig(config);
        emit(IPC_STREAM.REPOS_CHANGED, config.repos);
        jsonResponse(res, repo);
      } catch (e) {
        errorResponse(res, (e as Error).message, 400);
      }
      return;
    }

    case '/list-tasks': {
      const {
        status: filter = 'open',
        query: listQuery,
        repo: repoFilter,
        limit: listLimit,
      } = body as { status?: 'open' | 'running' | 'all'; query?: string; repo?: string; limit?: number };
      const listRepos = loadConfig().repos;
      const q = listQuery?.trim().toLowerCase();
      const rq = repoFilter?.trim().toLowerCase();
      const matching = [...getTasks(), ...peerTasks()]
        .filter((t) => {
          if (filter === 'running') return t.status === 'running';
          if (filter !== 'all' && t.status === 'archived') return false;
          return true;
        })
        .filter((t) => {
          if (!rq) return true;
          const repo = listRepos.find((r: Repo) => r.id === t.repoId);
          return !!repo && `${repo.name} ${repo.githubPath ?? ''} ${repo.path}`.toLowerCase().includes(rq);
        })
        .filter((t) => {
          if (!q) return true;
          const repo = listRepos.find((r: Repo) => r.id === t.repoId);
          const hay =
            `${t.name} ${t.branch ?? ''} ${t.baseBranch} ${t.worktreePath} ${getSessionName(t.id) ?? ''} ${repo?.name ?? ''}`.toLowerCase();
          return q.split(/\s+/).every((term) => hay.includes(term));
        })
        // Newest first, so a capped list keeps the tasks still in play.
        .sort((a, b) => b.createdAt - a.createdAt);
      const cap = Math.max(1, Math.min(listLimit ?? 50, 500));
      const tasks = matching.slice(0, cap).map((t) => ({
        id: t.id,
        name: t.name,
        repoId: t.repoId,
        status: t.status,
        idle: t.status === 'running' ? isIdle(t.id) : undefined,
        lastActiveAt: t.lastTurnBoundaryAt,
        machine: t.machine ?? process.env.BIFROST_MACHINE,
        branch: t.branch,
        baseBranch: t.baseBranch,
        worktreePath: t.worktreePath,
        createdAt: t.createdAt,
        sessionName: getSessionName(t.id),
      }));
      jsonResponse(res, { tasks, total: matching.length, truncated: matching.length > tasks.length });
      return;
    }

    case '/create-task': {
      const { repoId, repoPath, worktreePath, name, branch, branchName, prompt, createdByTaskId, machine } = body as {
        repoId?: string;
        repoPath?: string;
        worktreePath?: string;
        name?: string;
        branch?: string;
        branchName?: string;
        prompt?: string;
        createdByTaskId?: string;
        machine?: string;
      };
      if (!repoId && !repoPath && !worktreePath) {
        errorResponse(res, 'either repoId, repoPath or worktreePath is required');
        return;
      }
      const isAsync = body.async === true;
      console.log(
        `[api] create-task: body keys=${Object.keys(body).join(',')}, name=${name}, async=${isAsync}, prompt=${prompt ? `${prompt.length} chars` : 'none'}`,
      );
      const params = { repoId, repoPath, worktreePath, name, branch, branchName, prompt, createdByTaskId, machine };
      // An async caller is answered before the work runs, so the arguments are
      // settled first and a bad one comes back as a failed request.
      let target: TaskTarget;
      try {
        target = await resolveTaskTarget(params);
      } catch (e) {
        errorResponse(res, (e as Error).message, 400);
        return;
      }

      if (isAsync) {
        // Return immediately with a pending response, create in background
        jsonResponse(res, { ok: true, pending: true });
        createTaskCore(params, target)
          .then((task) => {
            emit(IPC_STREAM.TASK_CREATED, task);
          })
          .catch((e) => {
            const msg = (e as Error).message;
            console.error('[api] async create-task failed:', msg);
            emit(IPC_STREAM.TOAST, `Task creation failed: ${msg}`, 5000);
            reportCreateFailure(params, body.callerContext === 'console', target.repo.name, msg);
          });
      } else {
        try {
          const task = await createTaskCore(params, target);
          emit(IPC_STREAM.TASK_CREATED, task);

          jsonResponse(res, task);
        } catch (e) {
          errorResponse(res, (e as Error).message, 400);
        }
      }
      return;
    }

    case '/close-task': {
      const taskId = body.taskId as string;
      const archive = body.archive === true;
      const force = body.force === true;
      if (!taskId) {
        errorResponse(res, 'taskId is required');
        return;
      }
      try {
        const task = getTask(taskId);
        cancelTaskRequests(taskId);
        killTaskSessions(task);

        if (archive) {
          // Archive: stop + mark archived + remove worktree
          stopWatching(taskId);

          if (!force && task.machine && (await isRemoteWorktreeDirty(task))) {
            errorResponse(
              res,
              'Worktree has uncommitted changes, and archiving deletes them. Close it instead (archive=false) to keep the worktree, or ask the user before passing force=true.',
              409,
            );
            return;
          }
          // Check if worktree is dirty (unless forced or external/in-place)
          if (!force && !task.machine && !task.isExternal && !task.inPlace && fs.existsSync(task.worktreePath)) {
            try {
              const { stdout } = await execFile('git', ['--no-optional-locks', 'status', '--porcelain'], {
                cwd: task.worktreePath,
                timeout: 5000,
              });
              if (stdout.trim().length > 0) {
                errorResponse(
                  res,
                  'Worktree has uncommitted changes, and archiving deletes them. Close it instead (archive=false) to keep the worktree, or ask the user before passing force=true.',
                  409,
                );
                return;
              }
            } catch {
              // git status failed — proceed with archive
            }
          }

          // The UI archives through this same call, so multi-repo cleanup and
          // the detached-worktree guard hold for an agent's archive as well.
          const updated = await archiveTaskCore(taskId);

          emit(IPC_STREAM.TASK_CLOSED, taskId, true);
          jsonResponse(res, updated);
        } else {
          // Close: stop sessions + set status to stopped, preserve worktree
          const updated = updateTask(taskId, { status: 'stopped' });
          emit(IPC_STREAM.TASK_CLOSED, taskId, false);
          jsonResponse(res, updated);
        }
      } catch (e) {
        errorResponse(res, (e as Error).message, 400);
      }
      return;
    }

    case '/get-task-diff': {
      const targetId = resolveTaskId(body);
      if (!targetId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      try {
        const task = getTask(targetId);
        const diff = task.machine ? await getRemoteDiff(task) : await getDiff(task.worktreePath);
        jsonResponse(res, diff);
      } catch (e) {
        errorResponse(res, (e as Error).message, 404);
      }
      return;
    }

    case '/get-activity-log': {
      const targetId = resolveTaskId(body);
      const limit = (body.limit as number) || 50;
      if (!targetId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      try {
        const task = getTask(targetId);
        const entries = getActivityLog(targetId, task.worktreePath);
        jsonResponse(res, { entries: entries.slice(-limit) });
      } catch (e) {
        errorResponse(res, (e as Error).message, 404);
      }
      return;
    }

    case '/permission': {
      const cwd = body.cwd as string;
      const toolName = body.tool_name as string;
      const toolInput = (body.tool_input as Record<string, unknown>) || {};

      if (!cwd || !toolName) {
        errorResponse(res, 'Missing cwd or tool_name');
        return;
      }

      // Ahead of the managed-permission path, which most sessions return from
      // straight away: this is the moment the question reaches the user.
      if (WAITS_FOR_USER.has(toolName)) {
        const asking = hookTask(body);
        if (asking) awaitUser(asking);
      }

      // If permission management is disabled or permissions are bypassed, let Claude Code handle it
      const config = loadConfig();
      if (!config.managePermissions || config.permissionMode === 'skip-permissions') {
        jsonResponse(res, {});
        return;
      }

      const task = hookTask(body);
      if (!task) {
        jsonResponse(res, {});
        return;
      }

      // Check existing allow/deny rules before prompting
      const existingDecision = checkExistingRules(cwd, toolName, toolInput);
      if (existingDecision) {
        jsonResponse(res, {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: existingDecision,
          },
        });
        return;
      }

      // With nobody to show the question to, Claude asks in its own terminal.
      if (!listening()) {
        jsonResponse(res, {});
        return;
      }

      const { promptData, response } = createRequest(task.id, task.name, toolName, toolInput);

      // Send to renderer
      emit(IPC_STREAM.PERMISSION_PROMPT, promptData);

      // Notify the user, under the same floor every other trigger observes
      ringBell(task.id, task.name);

      // Hold connection open until resolved
      const result = await response;
      jsonResponse(res, result);
      return;
    }

    case '/hook': {
      const cwd = body.cwd as string;
      const hookContext = (body.bifrost_context as string) || 'code';
      const hookEventName = body.hook_event_name as string;
      if (!cwd) {
        errorResponse(res, 'Missing cwd');
        return;
      }

      // UserPromptSubmit — signal Claude is actively working + inject message nudge
      if (hookEventName === 'UserPromptSubmit' && hookContext === 'code') {
        const task = hookTask(body);
        if (task) {
          // A hook can go missing, so each turn starts the count over rather
          // than inheriting one that would hold the task working forever.
          forgetTask(task.id);
          markActive(task.id);
          turnBoundary(task.id);
          emit(IPC_STREAM.CLAUDE_ACTIVE, task.id, true);
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // The console has no worktree and no task to attribute an event to, so it
      // is answered here. Stop ends a turn and Notification means it has been
      // waiting. Either way it wants the user, and the debounce collapses the
      // two when both arrive.
      if (hookContext === 'console') {
        const wantsUser = hookEventName === 'Stop' || hookEventName === 'Notification';
        if (wantsUser && ringBell(CONSOLE_SESSION_ID, 'Console')) {
          emit(IPC_STREAM.CONSOLE_NOTIFICATION, (body.message as string) || '', (body.title as string) || '');
        }
        jsonResponse(res, { ok: true });
        return;
      }

      const task = hookTask(body);
      if (!task) {
        errorResponse(res, 'No matching task', 404);
        return;
      }

      // PostToolUse / SubagentStart — Claude is actively working, ensure sweep is on
      if (hookEventName === 'PostToolUse' || hookEventName === 'SubagentStart') {
        if (hookEventName === 'SubagentStart') {
          subagentStarted(task.id);
        }
        markActive(task.id);
        emit(IPC_STREAM.CLAUDE_ACTIVE, task.id, true);
        jsonResponse(res, { ok: true });
        return;
      }

      // The last subagent back finishes a turn that already stopped waiting.
      if (hookEventName === 'SubagentStop') {
        if (subagentStopped(task.id)) finishTurn(task);
        jsonResponse(res, { ok: true });
        return;
      }

      // SessionEnd — session terminated, definitively mark idle
      if (hookEventName === 'SessionEnd') {
        forgetTask(task.id);
        markIdle(task.id);
        emit(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
        jsonResponse(res, { ok: true });
        return;
      }

      // StopFailure — mark idle and notify (API/turn error)
      if (hookEventName === 'StopFailure') {
        if (hookContext === 'code') {
          forgetTask(task.id);
          markIdle(task.id);
          turnBoundary(task.id);
        }
        ringBell(task.id, task.name);
        emit(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
        emit(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, 'Claude stopped with an error', '', 'stop_failure');
        jsonResponse(res, { ok: true });
        return;
      }

      // PreCompact — informational, forward to renderer
      if (hookEventName === 'PreCompact') {
        emit(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, '', '', 'pre_compact');
        jsonResponse(res, { ok: true });
        return;
      }

      // Stop — mark task idle and stop sweep, notify user, but don't send
      // the hook's message fields (Stop doesn't carry notification content)
      if (hookEventName === 'Stop' && hookContext === 'code') {
        if (turnEnded(task.id)) finishTurn(task);
        jsonResponse(res, { ok: true });
        return;
      }

      // Notification is the one event that speaks to the user; anything else
      // reaching here is a hook this build does not act on.
      if (hookEventName !== 'Notification') {
        jsonResponse(res, { ok: true });
        return;
      }

      if (hookContext === 'code' && turnEnded(task.id)) {
        // Claude is waiting for input
        markIdle(task.id);
        turnBoundary(task.id);
        emit(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
      }
      if (!ringBell(task.id, task.name)) {
        jsonResponse(res, { ok: true, debounced: true });
        return;
      }
      const message = (body.message as string) || '';
      const title = (body.title as string) || '';
      const notificationType = (body.notification_type as string) || '';
      emit(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, message, title, notificationType);
      jsonResponse(res, { ok: true });
      return;
    }

    case '/find-task': {
      const query = String((body as { query?: string }).query ?? '').trim();
      if (!query) {
        errorResponse(res, 'No query provided');
        return;
      }
      const lower = query.toLowerCase();
      const all = [...getTasks(), ...peerTasks()];
      // Most specific first, and a tier that matches more than one task is
      // reported rather than resolved: naming the wrong task to message is
      // worse than naming none. A directory is matched by containment, since
      // the useful query is a session's cwd, at or below the worktree.
      const tiers: Array<(t: Task) => boolean> = [
        (t) => t.id === query,
        (t) => t.sessionId === query,
        (t) => query === t.worktreePath || query.startsWith(`${t.worktreePath}/`),
        (t) => getSessionName(t.id)?.toLowerCase() === lower,
        (t) => t.name.toLowerCase() === lower,
        (t) => t.branch?.toLowerCase() === lower,
      ];
      let found: Task | undefined;
      for (const matches of tiers) {
        const hits = all.filter(matches);
        if (hits.length === 1) {
          found = hits[0];
          break;
        }
        if (hits.length > 1) {
          jsonResponse(res, {
            ok: false,
            error: `"${query}" matches ${hits.length} tasks: ${hits.map((t) => `${t.name} (${t.id})`).join(', ')}`,
          });
          return;
        }
      }
      if (!found) {
        jsonResponse(res, { ok: false, error: `Nothing matches "${query}"` });
        return;
      }
      jsonResponse(res, {
        ok: true,
        task: {
          id: found.id,
          name: found.name,
          repoId: found.repoId,
          status: found.status,
          idle: found.status === 'running' ? isIdle(found.id) : undefined,
          lastActiveAt: found.lastTurnBoundaryAt,
          machine: found.machine ?? process.env.BIFROST_MACHINE,
          branch: found.branch,
          baseBranch: found.baseBranch,
          worktreePath: found.worktreePath,
          sessionId: found.sessionId,
          sessionName: getSessionName(found.id),
          createdByTaskId: found.createdByTaskId,
        },
      });
      return;
    }

    case '/wake-task': {
      const wakeId = resolveTaskId(body);
      if (!wakeId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      let wakeTask: Task;
      try {
        wakeTask = getTask(wakeId);
      } catch {
        errorResponse(res, `Task ${wakeId} not found`, 404);
        return;
      }
      if (wakeTask.status !== 'running') {
        jsonResponse(res, {
          ok: false,
          error: `Task is ${wakeTask.status}, not running. Use open_task to reopen it.`,
        });
        return;
      }
      // A session that has not started is invisible to ListAgents, so waking
      // one is what makes it addressable.
      const alreadyAwake = hasSession(wakeId);
      if (!alreadyAwake) {
        if (!isPendingRestore(wakeId)) {
          jsonResponse(res, { ok: false, error: 'Task has no session and cannot be restored' });
          return;
        }
        try {
          restoreTaskSession(wakeId);
        } catch (err) {
          // The restore drops the task from the pending set before it can fail,
          // so a task left running with neither is unreachable from here on.
          console.error(`[api] wake-task: failed to restore ${wakeId}:`, err);
          updateTask(wakeId, { status: 'error' });
          jsonResponse(res, { ok: false, error: 'Session failed to start' });
          return;
        }
      }
      // Waited for on both paths: a session spawned moments ago exists before
      // its TUI reads anything, and a name handed back then is not yet usable.
      if (!(await waitForSessionReady(wakeId))) {
        jsonResponse(res, { ok: false, error: notStartedReason(wakeId) });
        return;
      }
      // The name the session actually carries, which is the task's name from
      // when it started rather than its name now.
      jsonResponse(res, { ok: true, name: getSessionName(wakeId) ?? wakeTask.name, alreadyAwake });
      return;
    }

    case '/transfer-task': {
      const transferId = resolveTaskId(body);
      const machine = body.machine as string | undefined;
      if (!transferId || !machine) {
        errorResponse(res, 'taskId and machine are required');
        return;
      }
      try {
        jsonResponse(res, await transferTaskCore(transferId, machine));
      } catch (e) {
        errorResponse(res, (e as Error).message, 400);
      }
      return;
    }

    case '/open-task': {
      const openId = resolveTaskId(body);
      if (!openId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      let openTask: Task;
      try {
        openTask = getTask(openId);
      } catch {
        errorResponse(res, `Task ${openId} not found`, 404);
        return;
      }
      // A task already carrying a session is answered with its address, so a
      // caller that cannot tell a live task from an archived one still gets one.
      const wasOpen = openTask.status === 'running' && hasSession(openId);
      if (!wasOpen) {
        try {
          // A task still holding its worktree from before the restart needs the
          // session it is waiting for, not a reopen.
          if (isPendingRestore(openId)) {
            restoreTaskSession(openId);
            openTask = getTask(openId);
          } else {
            openTask = await reopenTaskCore(openId);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Task could not be opened';
          console.error(`[api] open-task: failed to open ${openId}:`, err);
          jsonResponse(res, { ok: false, error: message });
          return;
        }
      }
      if (!(await waitForSessionReady(openId))) {
        jsonResponse(res, { ok: false, error: notStartedReason(openId) });
        return;
      }
      jsonResponse(res, {
        ok: true,
        name: getSessionName(openId) ?? openTask.name,
        wasOpen,
        worktreePath: openTask.worktreePath,
      });
      return;
    }

    case '/send-prompt': {
      const targetId = resolveTaskId(body);
      const promptText = body.text as string;
      const mode = (body.mode as string) || 'direct';
      const waitForTurn = body.waitForTurn === true;
      if (!targetId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      if (!promptText) {
        errorResponse(res, 'No text provided');
        return;
      }
      const validModes = ['direct', 'queue', 'only-when-idle', 'interrupt'];
      if (!validModes.includes(mode)) {
        errorResponse(res, `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
        return;
      }
      try {
        const result = await sendPromptToTask(
          targetId,
          promptText,
          mode as 'direct' | 'queue' | 'only-when-idle' | 'interrupt',
          waitForTurn,
        );
        jsonResponse(res, result);
      } catch (e) {
        errorResponse(res, (e as Error).message, 400);
      }
      return;
    }

    case '/list-notes': {
      const targetId = resolveTaskId(body);
      if (!targetId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      try {
        const task = getTask(targetId);
        const notes = listNotes(task.repoId);
        jsonResponse(res, { notes });
      } catch (e) {
        errorResponse(res, (e as Error).message, 404);
      }
      return;
    }

    case '/delete-note': {
      const targetId = resolveTaskId(body);
      const noteId = body.noteId as string;
      if (!targetId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      if (!noteId) {
        errorResponse(res, 'No noteId provided');
        return;
      }
      try {
        const task = getTask(targetId);
        deleteNote(task.repoId, noteId);
        jsonResponse(res, { ok: true });
      } catch (e) {
        errorResponse(res, (e as Error).message, 404);
      }
      return;
    }

    case '/session-start': {
      const sessionId = body.session_id as string;
      const cwd = body.cwd as string;
      const context = body.bifrost_context as string;
      const taskId = body.bifrost_task_id as string;
      if (!sessionId || !cwd) {
        errorResponse(res, 'Missing session_id or cwd');
        return;
      }
      // The console has no task, so a hook from it has nothing to record.
      if (context === 'console') {
        jsonResponse(res, { ok: true });
        return;
      }
      // Look up task by ID first (most reliable), then fall back to CWD matching
      const task = taskId
        ? (() => {
            try {
              return getTask(taskId);
            } catch {
              return undefined;
            }
          })()
        : hookTask(body);
      if (!task) {
        jsonResponse(res, { ok: false, reason: 'no matching task' });
        return;
      }

      // Only update task.sessionId for 'code' context (the main Claude session in the Bifrost tab)
      // Other contexts (dev, etc.) don't update the stored sessionId
      if (context !== 'code') {
        jsonResponse(res, { ok: true });
        return;
      }

      // During --resume, Claude fires two SessionStart events:
      //   1. source=startup with a transient wrapper session ID
      //   2. source=resume  with the actual resumed session ID
      // Skip the wrapper event so it never overwrites the stored sessionId.
      const source = body.source as string;
      if (task.sessionId && source === 'startup') {
        jsonResponse(res, { ok: true });
        return;
      }
      if (task.sessionId !== sessionId) {
        // Preserve the old session ID in history (e.g. after /clear)
        const sessionHistory = task.sessionId ? [...(task.sessionHistory ?? []), task.sessionId] : task.sessionHistory;
        updateTask(task.id, { sessionId, sessionHistory });
        if (task.machine) {
          getRemoteHost(task.machine)
            .exec(sessionIdScript(task.id, sessionId))
            .catch((err) => console.warn(`[api] session-start: ${(err as Error).message}`));
        } else {
          writeLocalSessionId(os.homedir(), task.id, sessionId);
        }
      }
      jsonResponse(res, { ok: true });
      return;
    }

    default:
      errorResponse(res, 'Not found', 404);
  }
}

function tryListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      try {
        await handleRequest(req, res);
      } catch (e) {
        errorResponse(res, (e as Error).message, 500);
      }
    });
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => {
      server = s;
      activePort = port;
      resolve(true);
    });
  });
}

export async function startApi(): Promise<number | null> {
  for (let port = PORT_START; port <= PORT_END; port++) {
    if (await tryListen(port)) {
      // Write port file
      const dir = path.dirname(PORT_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PORT_FILE, String(port));
      return port;
    }
  }
  console.error('Bifrost API: could not bind to any port in range', PORT_START, '-', PORT_END);
  return null;
}

export function stopApi(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        server = null;
        try {
          fs.unlinkSync(PORT_FILE);
        } catch {
          // ignore
        }
        activePort = null;
        resolve();
      });
      // A held response, such as an event stream, would keep close() waiting for ever.
      server.closeAllConnections();
    } else {
      try {
        fs.unlinkSync(PORT_FILE);
      } catch {
        // ignore
      }
      activePort = null;
      resolve();
    }
  });
}

export function getApiPort(): number | null {
  return activePort;
}
