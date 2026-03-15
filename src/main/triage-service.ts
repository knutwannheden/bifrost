import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { DEFAULT_TRIAGE_PROMPT } from '../shared/default-prompts';
import { IPC_STREAM } from '../shared/ipc-channels';
import { loadConfig } from './config';
import { killSession, spawnSession } from './session-manager';
import { addTriage, listTriages, updateTriage } from './triage-store';

const TRIAGE_DIR = path.join(os.homedir(), '.bifrost', 'triage');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface TriageSession {
  id: string;
  ptySessionId: string;
  prompt: string;
  activityInterval: ReturnType<typeof setInterval> | null;
  claudeSessionId: string | null;
}

const sessions = new Map<string, TriageSession>();
const completedTriages = new Set<string>();

function getTriagePrompt(userPrompt: string): string {
  const config = loadConfig();
  const base = config.prompts?.triage || DEFAULT_TRIAGE_PROMPT;
  return `${base}

## User request
${userPrompt}

Analyze this request, determine the target repo, and create a task.`;
}

function projectDirName(dirPath: string): string {
  return dirPath.replace(/[/.]/g, '-');
}

function findSessionJsonl(cwd: string, sessionId: string): string | null {
  const filePath = path.join(CLAUDE_PROJECTS_DIR, projectDirName(cwd), `${sessionId}.jsonl`);
  return fs.existsSync(filePath) ? filePath : null;
}

function readLastActivity(filePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size === 0) return null;

  const readSize = Math.min(stat.size, 32768);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);

  const lines = buf
    .toString('utf-8')
    .split('\n')
    .filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type !== 'assistant') continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j].type === 'tool_use') {
          const name = content[j].name;
          const input = content[j].input as Record<string, unknown>;
          switch (name) {
            case 'Read':
              return `Reading ${input.file_path || ''}`;
            case 'Edit':
              return `Editing ${input.file_path || ''}`;
            case 'Write':
              return `Writing ${input.file_path || ''}`;
            case 'Bash':
              return `$ ${((input.command as string) || '').slice(0, 80)}`;
            case 'Glob':
              return `Searching ${input.pattern || ''}`;
            case 'Grep':
              return `Searching for /${input.pattern || ''}/`;
            case 'Task':
              return `Agent: ${input.description || ''}`;
            default:
              return name;
          }
        }
        if (content[j].type === 'text') {
          const text = ((content[j].text as string) || '').trim();
          if (text) return text.length > 100 ? `${text.slice(0, 100)}...` : text;
        }
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return null;
}

/** Read the last assistant text message (not tool_use) for summary. */
function readLastAssistantText(cwd: string, claudeSessionId: string): string | null {
  const filePath = findSessionJsonl(cwd, claudeSessionId);
  if (!filePath) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size === 0) return null;

  // Read last 64KB to find the final assistant message
  const readSize = Math.min(stat.size, 65536);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
  fs.closeSync(fd);

  const lines = buf
    .toString('utf-8')
    .split('\n')
    .filter((l) => l.trim());

  // Walk backwards to find the last assistant message with text content
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]);
      if (obj.type !== 'assistant') continue;
      const content = obj.message?.content;
      if (!Array.isArray(content)) continue;
      // Collect all text blocks from this message
      const texts: string[] = [];
      for (const block of content) {
        if (block.type === 'text') {
          const text = ((block.text as string) || '').trim();
          if (text) texts.push(text);
        }
      }
      if (texts.length > 0) {
        const full = texts.join(' ');
        return full.length > 300 ? `${full.slice(0, 300)}…` : full;
      }
    } catch {
      /* skip malformed lines */
    }
  }
  return null;
}

function startActivityWatch(triageId: string, mainWindow: BrowserWindow): void {
  const session = sessions.get(triageId);
  if (!session) return;

  let jsonlPath: string | null = null;
  let lastActivity = '';

  session.activityInterval = setInterval(() => {
    if (!session.claudeSessionId) return;
    if (!jsonlPath) {
      jsonlPath = findSessionJsonl(TRIAGE_DIR, session.claudeSessionId);
      if (!jsonlPath) return;
    }
    const activity = readLastActivity(jsonlPath);
    if (activity && activity !== lastActivity) {
      lastActivity = activity;
      updateTriage(triageId, { lastActivity: activity });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_STREAM.TRIAGE_ACTIVITY, triageId, activity);
      }
    }
  }, 1500);
}

function stopActivityWatch(triageId: string): void {
  const session = sessions.get(triageId);
  if (session?.activityInterval) {
    clearInterval(session.activityInterval);
    session.activityInterval = null;
  }
}

export function startTriage(prompt: string, mainWindow: BrowserWindow): { triageId: string; ptySessionId: string } {
  if (!fs.existsSync(TRIAGE_DIR)) {
    fs.mkdirSync(TRIAGE_DIR, { recursive: true });
  }

  const triageId = randomUUID();
  const ptySessionId = `triage-${triageId.slice(0, 8)}`;

  const session: TriageSession = {
    id: triageId,
    ptySessionId,
    prompt,
    activityInterval: null,
    claudeSessionId: null,
  };
  sessions.set(triageId, session);

  // Persist to history
  addTriage({
    id: triageId,
    prompt,
    createdAt: Date.now(),
    status: 'running',
  });

  const portFile = path.join(os.homedir(), '.bifrost', 'api-port');
  const extraEnv: Record<string, string> = {
    BIFROST_CONTEXT: 'triage',
    BIFROST_TRIAGE_ID: triageId,
  };
  try {
    extraEnv.BIFROST_API_PORT = fs.readFileSync(portFile, 'utf-8').trim();
  } catch {
    /* port file may not exist */
  }

  spawnSession(ptySessionId, 'claude', ['--dangerously-skip-permissions'], TRIAGE_DIR, mainWindow, {
    extraEnv,
    autoTrust: true,
    prompt: getTriagePrompt(prompt),
    onBeforeExit: (_buffer, exitCode) => {
      stopActivityWatch(triageId);
      const sess = sessions.get(triageId);
      const summary = sess?.claudeSessionId ? readLastAssistantText(TRIAGE_DIR, sess.claudeSessionId) : null;
      sessions.delete(triageId);
      const completed = completedTriages.delete(triageId);
      updateTriage(triageId, {
        status: exitCode === 0 || completed ? 'done' : 'error',
        completedAt: Date.now(),
        ...(summary && { summary }),
      });
      return false;
    },
  });

  startActivityWatch(triageId, mainWindow);

  return { triageId, ptySessionId };
}

export function completeTriage(triageId: string): void {
  const session = sessions.get(triageId);
  if (!session) return;
  completedTriages.add(triageId);
  killSession(session.ptySessionId);
}

export function cancelTriage(triageId: string): void {
  const session = sessions.get(triageId);
  if (!session) return;
  stopActivityWatch(triageId);
  killSession(session.ptySessionId);
  sessions.delete(triageId);
  updateTriage(triageId, { status: 'cancelled', completedAt: Date.now() });
}

export function setTriageSessionId(triageId: string, claudeSessionId: string): void {
  const session = sessions.get(triageId);
  if (session) {
    session.claudeSessionId = claudeSessionId;
  }
  // Persist for later resumption from history
  updateTriage(triageId, { claudeSessionId });
}

export function isTriageRunning(triageId: string): boolean {
  return sessions.has(triageId);
}

export function getRunningTriages(): Map<string, TriageSession> {
  return sessions;
}

/** Backfill claudeSessionId and summary for old triage entries that predate persistence. */
export function backfillTriageHistory(): void {
  const entries = listTriages();
  const needsBackfill = entries.filter((e) => !e.claudeSessionId && e.status !== 'running');
  if (needsBackfill.length === 0) return;

  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectDirName(TRIAGE_DIR));
  if (!fs.existsSync(projectDir)) return;

  // List all JSONL session files and read their start timestamps
  let files: string[];
  try {
    files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return;
  }

  const sessionInfos: { sessionId: string; startedAt: number }[] = [];
  for (const file of files) {
    const filePath = path.join(projectDir, file);
    try {
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
      fs.closeSync(fd);
      const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
      if (!firstLine) continue;
      const obj = JSON.parse(firstLine);
      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
      if (ts > 0) {
        sessionInfos.push({ sessionId: file.replace('.jsonl', ''), startedAt: ts });
      }
    } catch {
      // skip unreadable files
    }
  }

  if (sessionInfos.length === 0) return;

  // Sort sessions by start time
  sessionInfos.sort((a, b) => a.startedAt - b.startedAt);

  // Already-matched session IDs (avoid double-assigning)
  const usedSessions = new Set(entries.filter((e) => e.claudeSessionId).map((e) => e.claudeSessionId));

  let backfilled = 0;
  for (const entry of needsBackfill) {
    // Find the session that started closest to (and within 60s after) the triage's createdAt
    let bestMatch: (typeof sessionInfos)[0] | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const si of sessionInfos) {
      if (usedSessions.has(si.sessionId)) continue;
      const delta = si.startedAt - entry.createdAt;
      // Session should start within -5s to +60s of triage creation
      if (delta >= -5000 && delta <= 60000 && Math.abs(delta) < bestDelta) {
        bestDelta = Math.abs(delta);
        bestMatch = si;
      }
    }
    if (!bestMatch) continue;

    usedSessions.add(bestMatch.sessionId);
    const summary = readLastAssistantText(TRIAGE_DIR, bestMatch.sessionId);
    updateTriage(entry.id, {
      claudeSessionId: bestMatch.sessionId,
      ...(summary && { summary }),
    });
    backfilled++;
  }

  if (backfilled > 0) {
    console.log(`[triage] backfilled ${backfilled} history entries with session IDs`);
  }
}

export function enterTriage(triageId: string, mainWindow: BrowserWindow): { ptySessionId: string } | null {
  const entries = listTriages();
  const entry = entries.find((e) => e.id === triageId);
  if (!entry?.claudeSessionId) return null;

  const ptySessionId = `triage-history-${triageId.slice(0, 8)}`;

  // Kill any existing session for this triage
  killSession(ptySessionId);

  spawnSession(
    ptySessionId,
    'claude',
    ['--resume', entry.claudeSessionId, '--dangerously-skip-permissions'],
    TRIAGE_DIR,
    mainWindow,
    {},
  );

  return { ptySessionId };
}

export function addTriageTaskId(triageId: string, taskId: string): void {
  const entries = listTriages();
  const entry = entries.find((e) => e.id === triageId);
  if (entry) {
    const taskIds = [...(entry.taskIds ?? []), taskId];
    updateTriage(triageId, { taskIds });
  }
}
