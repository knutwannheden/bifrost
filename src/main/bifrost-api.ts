import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';
import { getActivityLog } from './activity-watcher';
import { loadConfig, saveConfig } from './config';
import { resolve as resolveContext } from './context-store';
import { getDiff } from './diff-service';
import { createTaskCore, getTask, getTasks, updateTask } from './ipc-handlers';
import { deleteNote, listNotes } from './note-store';
import { getActiveTaskId, handleBellNotification, isDebounced, markNotified } from './notification-service';
import { checkExistingRules, createRequest } from './permission-manager';
import { addRepo } from './repo-manager';
import { completeReview, setReviewSessionId, startReviewActivityWatch } from './review-service';
import { addTriageTaskId, completeTriage, setTriageSessionId } from './triage-service';

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

  if (sessionId) {
    const sessionFilePath = path.join(projectPath, `${sessionId}.jsonl`);
    try {
      return fs.statSync(sessionFilePath).mtimeMs;
    } catch {
      return null;
    }
  }

  // No sessionId — find the most recently modified .jsonl
  try {
    const files = fs
      .readdirSync(projectPath)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const fp = path.join(projectPath, f);
        return fs.statSync(fp).mtimeMs;
      });
    return files.length > 0 ? Math.max(...files) : null;
  } catch {
    return null;
  }
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
      const tasks = getTasks().map((t) => ({
        id: t.id,
        name: t.name,
        repoId: t.repoId,
        status: t.status,
        branch: t.branch,
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
      try {
        const task = await createTaskCore(
          { repoId, repoPath, name, branch: branch || 'main', branchName, prompt },
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
      const hookContext = (body.bifrost_context as string) || 'code';
      const hookTaskId = body.bifrost_task_id as string;
      if (!cwd) {
        errorResponse(res, 'Missing cwd');
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

      // Review stop — review is complete, kill the session so the Promise resolves
      if (hookContext === 'review' && hookTaskId) {
        completeReview(hookTaskId);
        jsonResponse(res, { ok: true });
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
        mainWindow.webContents.send(IPC_STREAM.HOOK_NOTIFICATION, task.id, task.name, message, title, notificationType);
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
