import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow } from 'electron';
import type { Repo } from '../shared/types';

const execFile = promisify(execFileCb);

import { IPC_STREAM } from '../shared/ipc-channels';
import { getActivityLog, stopWatching } from './activity-watcher';
import { loadConfig, saveConfig } from './config';
import { resolve as resolveContext } from './context-store';
import { getDiff } from './diff-service';
import { createTaskCore, getTask, getTasks, updateTask } from './ipc-handlers';
import {
  cleanupTask as cleanupMessages,
  getUnreadCount,
  readMessages,
  replyToMessage,
  sendMessage,
} from './message-store';
import { deleteNote, listNotes } from './note-store';
import { getActiveTaskId, handleBellNotification, isDebounced, markNotified } from './notification-service';
import { cancelTaskRequests, checkExistingRules, createRequest } from './permission-manager';
import { initPromptSender, isIdle, markActive, markIdle, sendPrompt as sendPromptToTask } from './prompt-sender';
import { addRepo } from './repo-manager';
import {
  cancelReview,
  completeReview,
  getActiveReviewFile,
  setReviewSessionId,
  startReviewActivityWatch,
} from './review-service';
import { killSession } from './session-manager';
import { completeSupervisorItem } from './supervisor-service';
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
 * Get the mtime of the JSONL session file for a given worktree/session.
 * Returns epoch ms, or null if the file cannot be found.
 */
export function getSessionMtime(worktreePath: string, sessionId?: string): number | null {
  const encoded = worktreePath.replace(/[/.]/g, '-');
  const projectPath = path.join(os.homedir(), '.claude', 'projects', encoded);

  if (!fs.existsSync(projectPath)) return null;

  // The newest transcript in the directory, which covers sessions replaced by
  // /clear or a resume as well as the one named by sessionId.
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
 * Resolve a task identifier that may be an ID, exact name, or partial name match.
 * Returns the task, or null if not found / ambiguous.
 */
function findTask(idOrName: string): import('../shared/types').Task | null {
  // Try exact ID first
  try {
    return getTask(idOrName);
  } catch {
    // fall through to name matching
  }

  const allTasks = getTasks();
  const lower = idOrName.toLowerCase();

  // Exact name match (case-insensitive)
  const exactName = allTasks.find((t) => t.name.toLowerCase() === lower);
  if (exactName) return exactName;

  // Partial name/branch match — only if unambiguous
  const partials = allTasks.filter(
    (t) => t.name.toLowerCase().includes(lower) || (t.branch ?? t.baseBranch ?? '').toLowerCase().includes(lower),
  );
  if (partials.length === 1) return partials[0];

  return null;
}

/**
 * Kill all sessions associated with a task: main, dev terminal, and review.
 * Uses deterministic session IDs so we don't need the in-memory Maps from ipc-handlers.
 */
function killTaskSessions(taskId: string): void {
  killSession(taskId);
  killSession(`${taskId}-dev`);
  killSession(`${taskId}-review`);
  cancelReview(taskId);
  cleanupMessages(taskId);
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
        }));
      jsonResponse(res, { tasks });
      return;
    }

    case '/create-task': {
      const { repoId, repoPath, name, branch, branchName, prompt } = body as {
        repoId?: string;
        repoPath?: string;
        name?: string;
        branch?: string;
        branchName?: string;
        prompt?: string;
      };
      if (!repoId && !repoPath) {
        errorResponse(res, 'either repoId or repoPath is required');
        return;
      }
      const isAsync = body.async === true;
      console.log(
        `[api] create-task: body keys=${Object.keys(body).join(',')}, name=${name}, async=${isAsync}, prompt=${prompt ? prompt.length + ' chars' : 'none'}`,
      );
      if (isAsync) {
        // Return immediately with a pending response, create in background
        jsonResponse(res, { ok: true, pending: true });
        createTaskCore({ repoId, repoPath, name, branch, branchName, prompt }, mainWindow!)
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
          const task = await createTaskCore({ repoId, repoPath, name, branch, branchName, prompt }, mainWindow!);
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
      // Helper: build additionalContext nudge if there are unread messages
      const messageContext = (taskId: string): string | undefined => {
        const count = getUnreadCount(taskId);
        if (count === 0) return undefined;
        const s = count === 1 ? '' : 's';
        return `\u26a1 You have ${count} new Bifrost agent message${s}. Use the Bifrost read_messages MCP tool to read and respond.`;
      };

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
        const pmTask = getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
        const ctx = pmTask ? messageContext(pmTask.id) : undefined;
        jsonResponse(res, ctx ? { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: ctx } } : {});
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
        const ctx = messageContext(task.id);
        jsonResponse(res, {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: existingDecision,
            ...(ctx ? { additionalContext: ctx } : {}),
          },
        });
        return;
      }

      const { promptData, response } = createRequest(task.id, task.name, toolName, toolInput);

      // Send to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.PERMISSION_PROMPT, promptData);
      }

      // Notify user
      handleBellNotification(task.id, task.name, getActiveTaskId() === task.id);

      // Hold connection open until resolved
      const result = await response;
      jsonResponse(res, result);
      return;
    }

    case '/hook': {
      const cwd = body.cwd as string;
      const hookContext = (body.bifrost_context as string) || 'code';
      const hookTaskId = body.bifrost_task_id as string;
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
          const count = getUnreadCount(task.id);
          if (count > 0) {
            const s = count === 1 ? '' : 's';
            jsonResponse(res, {
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: `\u26a1 You have ${count} new Bifrost agent message${s}. Use the Bifrost read_messages MCP tool to read and respond.`,
              },
            });
            return;
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

      // Supervisor stop — the item's Claude session finished its turn
      const hookSupervisorItemId = body.bifrost_supervisor_item_id as string;
      if (hookEventName === 'Stop' && hookContext === 'supervisor' && hookSupervisorItemId) {
        completeSupervisorItem(hookSupervisorItemId);
        jsonResponse(res, { ok: true });
        return;
      }

      // Review stop — only kill the session if the review file was actually written.
      // The Stop hook fires after every turn, including the first turn where Claude
      // may just acknowledge the prompt without producing output yet.
      if (hookContext === 'review' && hookTaskId) {
        const reviewFile = getActiveReviewFile(hookTaskId);
        if (reviewFile && fs.existsSync(reviewFile)) {
          completeReview(hookTaskId);
        }
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
        handleBellNotification(task.id, task.name, getActiveTaskId() === task.id);
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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.CLAUDE_ACTIVE, task.id, false);
        }
        if (!isDebounced(task.id)) {
          markNotified(task.id);
          handleBellNotification(task.id, task.name, getActiveTaskId() === task.id);
        }
        jsonResponse(res, { ok: true });
        return;
      }

      // Notification — mark idle (Claude is waiting for input) and forward message
      if (hookEventName === 'Notification' && hookContext === 'code') {
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
      handleBellNotification(task.id, task.name, getActiveTaskId() === task.id);
      const message = (body.message as string) || '';
      const title = (body.title as string) || '';
      const notificationType = (body.notification_type as string) || '';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, message, title, notificationType);
      }
      jsonResponse(res, { ok: true });
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

    case '/send-message': {
      const fromTaskId = body.fromTaskId as string;
      const fromTaskName = body.fromTaskName as string;
      const toTaskId = body.toTaskId as string;
      const text = body.text as string;
      const type = body.type as 'tell' | 'ask';
      const mode = (body.mode as string) || 'queue';
      if (!fromTaskId || !fromTaskName || !toTaskId || !text || !type) {
        errorResponse(res, 'Missing required fields: fromTaskId, fromTaskName, toTaskId, text, type');
        return;
      }
      const validModes = ['queue', 'direct', 'interrupt'];
      if (!validModes.includes(mode)) {
        errorResponse(res, `Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
        return;
      }
      const recipient = findTask(toTaskId);
      if (!recipient) {
        errorResponse(res, `Recipient task "${toTaskId}" not found`, 404);
        return;
      }
      const result = sendMessage(
        fromTaskId,
        fromTaskName,
        recipient.id,
        text,
        type,
        mode as 'queue' | 'direct' | 'interrupt',
      );
      if (type === 'ask' && result.replyPromise) {
        try {
          const reply = await result.replyPromise;
          jsonResponse(res, { messageId: result.messageId, reply });
        } catch (e) {
          errorResponse(res, (e as Error).message, 408);
        }
      } else {
        jsonResponse(res, { messageId: result.messageId });
      }
      return;
    }

    case '/read-messages': {
      const targetId = resolveTaskId(body);
      if (!targetId) {
        errorResponse(res, 'No taskId provided');
        return;
      }
      const messages = readMessages(targetId);
      jsonResponse(res, { messages });
      return;
    }

    case '/reply-message': {
      const messageId = body.messageId as string;
      const text = body.text as string;
      if (!messageId || !text) {
        errorResponse(res, 'Missing required fields: messageId, text');
        return;
      }
      try {
        replyToMessage(messageId, text);
        jsonResponse(res, { ok: true });
      } catch (e) {
        errorResponse(res, (e as Error).message, 400);
      }
      return;
    }

    case '/session-start': {
      const sessionId = body.session_id as string;
      const cwd = body.cwd as string;
      const context = body.bifrost_context as string;
      const taskId = body.bifrost_task_id as string;
      const reviewId = body.bifrost_review_id as string;
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
      // Supervisor context — no per-item session tracking yet
      if (context === 'supervisor') {
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

      // Review context — capture session ID and start activity watch
      if (context === 'review' && reviewId) {
        setReviewSessionId(task.id, reviewId, sessionId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.REVIEW_SESSION, task.id, reviewId, sessionId);
          startReviewActivityWatch(task.id, reviewId, cwd, sessionId, mainWindow);
        }
        jsonResponse(res, { ok: true });
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
