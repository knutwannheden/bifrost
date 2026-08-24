import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow } from 'electron';
import type { Repo, Task } from '../shared/types';

const execFile = promisify(execFileCb);

import { IPC_STREAM } from '../shared/ipc-channels';
import { getActivityLog, stopWatching } from './activity-watcher';
import { loadConfig, saveConfig } from './config';
import { resolve as resolveContext } from './context-store';
import { getDiff } from './diff-service';
import { createTaskCore, getTask, getTasks, isPendingRestore, restoreTaskSession, updateTask } from './ipc-handlers';
import { deleteNote, listNotes } from './note-store';
import { handleBellNotification, isDebounced, markNotified } from './notification-service';
import { cancelTaskRequests, checkExistingRules, createRequest } from './permission-manager';
import { markPrIndexStale } from './pr-index';
import { initPromptSender, isIdle, markActive, markIdle, sendPrompt as sendPromptToTask } from './prompt-sender';
import { addRepo } from './repo-manager';
import { getSessionName, hasSession, killSession, waitForSessionReady } from './session-manager';
import { addTriageTaskId, completeTriage, setTriageSessionId } from './triage-service';
import { removeWorktree } from './worktree-manager';

let mainWindow: BrowserWindow | null = null;

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

/**
 * Get the mtime of the most recently modified JSONL transcript for a worktree.
 * Returns epoch ms, or null if none can be found.
 */
export function getSessionMtime(worktreePath: string): number | null {
  const encoded = worktreePath.replace(/[/.]/g, '-');
  const projectPath = path.join(os.homedir(), '.claude', 'projects', encoded);

  if (!fs.existsSync(projectPath)) return null;

  try {
    const mtimes = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => fs.statSync(path.join(projectPath, f)).mtimeMs);
    return mtimes.length > 0 ? Math.max(...mtimes) : null;
  } catch {
    return null;
  }
}

export function initApi(window: BrowserWindow): void {
  mainWindow = window;
  initPromptSender(window);
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

function resolveTaskId(body: Record<string, unknown>): string | undefined {
  return (body.taskId as string) || (body.callerTaskId as string) || undefined;
}

/**
 * Kill both of a task's sessions: the main one and its dev terminal. Uses
 * deterministic session IDs so we don't need the in-memory Maps from ipc-handlers.
 */
function killTaskSessions(taskId: string): void {
  killSession(taskId);
  killSession(`${taskId}-dev`);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    errorResponse(res, 'Method not allowed', 405);
    return;
  }

  const body = await readJsonBody(req);

  switch (req.url) {
    case '/resolve-context': {
      const id = body.id as number;
      if (typeof id !== 'number') {
        errorResponse(res, 'Missing or invalid id');
        return;
      }
      const entry = resolveContext(id);
      if (!entry) {
        errorResponse(res, `Context #${id} not found or expired`, 404);
        return;
      }
      jsonResponse(res, entry);
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
        const existing = config.repos.find((r: { path: string }) => r.path === path.resolve(repoPath));
        if (existing) {
          jsonResponse(res, existing);
          return;
        }
        const repo = await addRepo({ type: 'local', path: repoPath });
        config.repos.push(repo);
        saveConfig(config);
        jsonResponse(res, repo);
      } catch (e) {
        errorResponse(res, (e as Error).message, 400);
      }
      return;
    }

    case '/list-tasks': {
      const filter = (body as { status?: 'open' | 'running' | 'all' }).status ?? 'open';
      const tasks = getTasks()
        .filter((t) => {
          if (filter === 'all') return true;
          if (filter === 'running') return t.status === 'running';
          return t.status !== 'archived';
        })
        .map((t) => ({
          id: t.id,
          name: t.name,
          repoId: t.repoId,
          status: t.status,
          idle: t.status === 'running' ? isIdle(t.id) : undefined,
          branch: t.branch,
          baseBranch: t.baseBranch,
          worktreePath: t.worktreePath,
          createdAt: t.createdAt,
          sessionName: getSessionName(t.id),
        }));
      jsonResponse(res, { tasks });
      return;
    }

    case '/create-task': {
      const { repoId, repoPath, name, branch, branchName, prompt, createdByTaskId } = body as {
        repoId?: string;
        repoPath?: string;
        name?: string;
        branch?: string;
        branchName?: string;
        prompt?: string;
        createdByTaskId?: string;
      };
      if (!repoId && !repoPath) {
        errorResponse(res, 'either repoId or repoPath is required');
        return;
      }
      const isAsync = body.async === true;
      console.log(
        `[api] create-task: body keys=${Object.keys(body).join(',')}, name=${name}, async=${isAsync}, prompt=${prompt ? `${prompt.length} chars` : 'none'}`,
      );
      if (isAsync) {
        // Return immediately with a pending response, create in background
        jsonResponse(res, { ok: true, pending: true });
        createTaskCore({ repoId, repoPath, name, branch, branchName, prompt, createdByTaskId }, mainWindow!)
          .then((task) => {
            mainWindow!.webContents.send(IPC_STREAM.TASK_CREATED, task);
            const callerTriageId = body.bifrost_triage_id as string;
            if (callerTriageId) addTriageTaskId(callerTriageId, task.id);
          })
          .catch((e) => {
            const msg = (e as Error).message;
            console.error('[api] async create-task failed:', msg);
            mainWindow!.webContents.send(IPC_STREAM.TOAST, `Task creation failed: ${msg}`, 5000);
          });
      } else {
        try {
          const task = await createTaskCore(
            { repoId, repoPath, name, branch, branchName, prompt, createdByTaskId },
            mainWindow!,
          );
          mainWindow!.webContents.send(IPC_STREAM.TASK_CREATED, task);

          // Track task created by triage session
          const callerTriageId = body.bifrost_triage_id as string;
          if (callerTriageId) {
            addTriageTaskId(callerTriageId, task.id);
          }

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
        killTaskSessions(taskId);

        if (archive) {
          // Archive: stop + mark archived + remove worktree
          stopWatching(taskId);

          // Check if worktree is dirty (unless forced or external/in-place)
          if (!force && !task.isExternal && !task.inPlace && fs.existsSync(task.worktreePath)) {
            try {
              const { stdout } = await execFile('git', ['--no-optional-locks', 'status', '--porcelain'], {
                cwd: task.worktreePath,
                timeout: 5000,
              });
              if (stdout.trim().length > 0) {
                errorResponse(res, 'Worktree has uncommitted changes. Use force=true to archive anyway.', 409);
                return;
              }
            } catch {
              // git status failed — proceed with archive
            }
          }

          const updated = updateTask(taskId, { status: 'archived', archivedAt: Date.now() });

          // Remove worktree in the background
          if (!task.isExternal && !task.inPlace && fs.existsSync(task.worktreePath)) {
            const config = loadConfig();
            const repo = config.repos.find((r: Repo) => r.id === task.repoId);
            if (repo) {
              removeWorktree(repo.path, task.worktreePath).catch(() => {});
            }
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_STREAM.TASK_CLOSED, taskId, true);
          }
          jsonResponse(res, updated);
        } else {
          // Close: stop sessions + set status to stopped, preserve worktree
          const updated = updateTask(taskId, { status: 'stopped' });
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_STREAM.TASK_CLOSED, taskId, false);
          }
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
        const diff = await getDiff(task.worktreePath);
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

      // If permission management is disabled or permissions are bypassed, let Claude Code handle it
      const config = loadConfig();
      if (!config.managePermissions || config.permissionMode === 'skip-permissions') {
        jsonResponse(res, {});
        return;
      }

      const task = getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
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

      const { promptData, response } = createRequest(task.id, task.name, toolName, toolInput);

      // Send to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.PERMISSION_PROMPT, promptData);
      }

      // Notify the user, under the same floor every other trigger observes
      if (!isDebounced(task.id)) {
        markNotified(task.id);
        handleBellNotification(task.name);
      }

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
        const task = getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
        if (task) {
          markActive(task.id);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, task.id, true);
          }
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // Triage stop — notify renderer and complete the session
      const hookTriageId = body.bifrost_triage_id as string;
      if (hookContext === 'triage' && hookTriageId) {
        const hookMessage = (body.last_assistant_message as string) || '';
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.TRIAGE_WAITING, hookTriageId, hookMessage);
        }
        completeTriage(hookTriageId);
        jsonResponse(res, { ok: true });
        return;
      }

      const task = getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
      if (!task) {
        errorResponse(res, 'No matching task', 404);
        return;
      }

      // PostToolUse / SubagentStart — Claude is actively working, ensure sweep is on
      if (hookEventName === 'PostToolUse' || hookEventName === 'SubagentStart') {
        markActive(task.id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, task.id, true);
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // SessionEnd — session terminated, definitively mark idle
      if (hookEventName === 'SessionEnd') {
        markIdle(task.id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // StopFailure — mark idle and notify (API/turn error)
      if (hookEventName === 'StopFailure') {
        if (hookContext === 'code') {
          markIdle(task.id);
        }
        if (!isDebounced(task.id)) {
          markNotified(task.id);
          handleBellNotification(task.name);
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
          mainWindow.webContents.send(
            IPC_STREAM.HOOK_NOTIFICATION,
            task.id,
            task.name,
            'Claude stopped with an error',
            '',
            'stop_failure',
          );
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // PreCompact — informational, forward to renderer
      if (hookEventName === 'PreCompact') {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, '', '', 'pre_compact');
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // Stop — mark task idle and stop sweep, notify user, but don't send
      // the hook's message fields (Stop doesn't carry notification content)
      if (hookEventName === 'Stop' && hookContext === 'code') {
        markIdle(task.id);
        // A turn that just ended is the likeliest moment for a PR to exist.
        markPrIndexStale(task.repoId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
        }
        if (!isDebounced(task.id)) {
          markNotified(task.id);
          handleBellNotification(task.name);
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // Notification is the one event that speaks to the user; anything else
      // reaching here is a hook this build does not act on.
      if (hookEventName !== 'Notification') {
        jsonResponse(res, { ok: true });
        return;
      }

      if (hookContext === 'code') {
        // Claude is waiting for input
        markIdle(task.id);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
        }
      }
      if (isDebounced(task.id)) {
        jsonResponse(res, { ok: true, debounced: true });
        return;
      }
      markNotified(task.id);
      handleBellNotification(task.name);
      const message = (body.message as string) || '';
      const title = (body.title as string) || '';
      const notificationType = (body.notification_type as string) || '';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, message, title, notificationType);
      }
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
      const all = getTasks();
      // Ordered by how exactly the query identifies a task, so a directory or a
      // session id answers with one task rather than everything under it.
      const found =
        all.find((t) => t.id === query) ??
        all.find((t) => t.sessionId === query) ??
        all.find((t) => t.worktreePath === query) ??
        all.find((t) => getSessionName(t.id)?.toLowerCase() === lower) ??
        all.find((t) => t.name.toLowerCase() === lower) ??
        all.find((t) => t.branch?.toLowerCase() === lower) ??
        all.find((t) => t.worktreePath.toLowerCase().startsWith(lower));
      if (!found) {
        jsonResponse(res, { ok: false, error: `Nothing matches "${query}"` });
        return;
      }
      jsonResponse(res, {
        ok: true,
        task: {
          id: found.id,
          name: found.name,
          status: found.status,
          idle: found.status === 'running' ? isIdle(found.id) : undefined,
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
        jsonResponse(res, { ok: false, error: `Task is ${wakeTask.status}, not running` });
        return;
      }
      // A session Bifrost has not spawned yet is invisible to ListAgents, so
      // waking one is what makes it addressable.
      const alreadyAwake = hasSession(wakeId);
      if (!alreadyAwake) {
        if (!isPendingRestore(wakeId) || !mainWindow || mainWindow.isDestroyed()) {
          jsonResponse(res, { ok: false, error: 'Task has no session and cannot be restored' });
          return;
        }
        restoreTaskSession(wakeId, mainWindow);
        if (!(await waitForSessionReady(wakeId))) {
          jsonResponse(res, { ok: false, error: 'Session did not finish starting up' });
          return;
        }
      }
      // The name the session actually carries, which is the task's name from
      // when it started rather than its name now.
      jsonResponse(res, { ok: true, name: getSessionName(wakeId) ?? wakeTask.name, alreadyAwake });
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
      // Triage context — capture session ID for activity polling
      const triageId = body.bifrost_triage_id as string;
      if (context === 'triage' && triageId) {
        setTriageSessionId(triageId, sessionId);
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
        : getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
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
