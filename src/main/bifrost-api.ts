import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserWindow } from 'electron';
import { resolve as resolveContext } from './context-store';
import { getTasks, getTask, updateTask } from './ipc-handlers';
import { setReviewSessionId, startReviewActivityWatch } from './review-service';
import { getDiff } from './diff-service';
import { getActivityLog } from './activity-watcher';
import { isDebounced, markNotified, handleBellNotification, getActiveTaskId } from './notification-service';
import { listNotes, deleteNote } from './note-store';
import { createRequest, checkExistingRules } from './permission-manager';
import { loadConfig } from './config';
import { IPC_STREAM } from '../shared/ipc-channels';

let mainWindow: BrowserWindow | null = null;

// Track /session-start call counts per task. When resuming (either via REOPEN_TASK or
// manual /resume), Claude makes multiple calls. We skip the first one and allow updates after.
const sessionStartCallCounts = new Map<string, number>();

function incrementSessionStartCallCount(taskId: string): number {
  const count = (sessionStartCallCounts.get(taskId) ?? 0) + 1;
  sessionStartCallCounts.set(taskId, count);
  return count;
}

export function registerResumeAttempt(taskId: string): void {
  // Reset call count when resumption is registered (for REOPEN_TASK case)
  sessionStartCallCounts.set(taskId, 0);
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

  // If sessionId provided, check if that specific session file exists
  if (sessionId) {
    const sessionFilePath = path.join(projectPath, `${sessionId}.jsonl`);
    return !fs.existsSync(sessionFilePath);
  }

  // Project exists but no sessionId provided, so we can't confirm it's valid
  return false;
}

export function initApi(window: BrowserWindow): void {
  mainWindow = window;
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

    case '/list-tasks': {
      const tasks = getTasks().map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        branch: t.branch,
        worktreePath: t.worktreePath,
        createdAt: t.createdAt,
      }));
      jsonResponse(res, { tasks });
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
        // No matching task — fall back to Claude default
        jsonResponse(res, {});
        return;
      }

      // Check existing allow/deny rules before prompting
      const existingDecision = checkExistingRules(cwd, toolName, toolInput);
      if (existingDecision) {
        jsonResponse(res, {
          hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: existingDecision },
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
      if (!cwd) {
        errorResponse(res, 'Missing cwd');
        return;
      }
      const task = getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
      if (!task) {
        errorResponse(res, 'No matching task', 404);
        return;
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
        mainWindow.webContents.send(
          IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, message, title, notificationType,
        );
      }
      jsonResponse(res, { ok: true });
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

    case '/agent-busy':
    case '/agent-idle': {
      const cwd = body.cwd as string;
      if (!cwd) {
        errorResponse(res, 'Missing cwd');
        return;
      }
      const task = getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
      if (!task) {
        jsonResponse(res, { ok: false });
        return;
      }
      const busy = req.url === '/agent-busy';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.AGENT_BUSY, task.id, busy);
      }
      jsonResponse(res, { ok: true });
      return;
    }

    case '/session-start': {
      const sessionId = body.session_id as string;
      const cwd = body.cwd as string;
      const context = body.bifrost_context as string;
      const taskId = body.bifrost_task_id as string;
      const reviewId = body.bifrost_review_id as string;
      const supervisorItemId = body.bifrost_supervisor_item_id as string;
      if (!sessionId || !cwd) {
        errorResponse(res, 'Missing session_id or cwd');
        return;
      }
      // Supervisor context — set session ID on the supervisor item
      if (context === 'supervisor' && supervisorItemId) {
        setSupervisorItemSessionId(supervisorItemId, sessionId);
        jsonResponse(res, { ok: true });
        return;
      }
      // Look up task by ID first (most reliable), then fall back to CWD matching
      const task = taskId
        ? (() => { try { return getTask(taskId); } catch { return undefined; } })()
        : getTasks().find((t) => t.status === 'running' && t.worktreePath === cwd);
      if (!task) {
        jsonResponse(res, { ok: false, reason: 'no matching task' });
        return;
      }
      // Handle sessionId capture:
      // - First time (undefined): always capture
      // - After first call (callCount > 1) in regular context: allow updates (handles resumption)
      // This works for both registered resumptions (REOPEN_TASK) and immediate /resume commands
      const callCount = context === 'code' ? incrementSessionStartCallCount(task.id) : 0;

      if (!task.sessionId && sessionId) {
        // First time: always capture when undefined
        updateTask(task.id, { sessionId });
      } else if (context === 'code' && callCount > 1 && task.sessionId !== sessionId) {
        // After first /session-start call: allow updates if sessionId differs
        // This handles both registered resumptions and immediate /resume commands
        updateTask(task.id, { sessionId });
      }
      if (context === 'review' && reviewId) {
        setReviewSessionId(task.id, reviewId, sessionId);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_STREAM.REVIEW_SESSION, task.id, reviewId, sessionId);
          startReviewActivityWatch(task.id, reviewId, cwd, sessionId, mainWindow);
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

export function stopApi(): void {
  if (server) {
    server.close();
    server = null;
  }
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    // ignore
  }
  activePort = null;
}

export function getApiPort(): number | null {
  return activePort;
}
