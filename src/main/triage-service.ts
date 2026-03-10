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
      sessions.delete(triageId);
      const completed = completedTriages.delete(triageId);
      updateTriage(triageId, {
        status: exitCode === 0 || completed ? 'done' : 'error',
        completedAt: Date.now(),
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
}

export function isTriageRunning(triageId: string): boolean {
  return sessions.has(triageId);
}

export function getRunningTriages(): Map<string, TriageSession> {
  return sessions;
}

export function addTriageTaskId(triageId: string, taskId: string): void {
  const entries = listTriages();
  const entry = entries.find((e) => e.id === triageId);
  if (entry) {
    const taskIds = [...(entry.taskIds ?? []), taskId];
    updateTriage(triageId, { taskIds });
  }
}
