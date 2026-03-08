import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';
import type { ActivityEntry } from '../shared/types';
import { loadConfig } from './config';
import { summarizeTask } from './task-summarizer';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface ClaudeWatcher {
  taskId: string;
  sessionId?: string;
  projectDir: string;
  /** Byte offset per JSONL file so we only read new lines */
  fileOffsets: Map<string, number>;
  pollTimer: ReturnType<typeof setInterval>;
  /** Total JSONL lines seen so far */
  lineCount: number;
  /** lineCount at which we last triggered a summary */
  lastSummaryAt: number;
}

const watchers = new Map<string, ClaudeWatcher>();

/**
 * Derive the Claude projects directory name from a worktree path.
 * Claude Code uses the absolute path with `/` and `.` replaced by `-`.
 */
function projectDirName(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-');
}

function parseJsonlLine(line: string, taskId: string): ActivityEntry | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const type = obj.type as string;
  const timestamp = obj.timestamp ? new Date(obj.timestamp as string).getTime() : Date.now();

  if (type === 'user') {
    const message = obj.message as { content?: unknown } | undefined;
    if (!message?.content) return null;

    let text: string;
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      // Extract text blocks from content array, skip tool_result blocks
      const textParts = (message.content as Record<string, unknown>[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text as string);
      if (textParts.length === 0) return null;
      text = textParts.join('\n');
    } else {
      return null;
    }

    return {
      id: randomUUID(),
      taskId,
      timestamp,
      type: 'claude_event',
      claudeEventKind: 'user_message',
      claudeText: text,
    };
  }

  if (type === 'assistant') {
    const msg = obj.message as { content?: unknown[] } | undefined;
    if (!msg?.content || !Array.isArray(msg.content)) return null;

    const entries: ActivityEntry[] = [];

    for (const block of msg.content as Record<string, unknown>[]) {
      if (block.type === 'text') {
        const text = ((block.text as string) || '').trim();
        if (text) {
          entries.push({
            id: randomUUID(),
            taskId,
            timestamp,
            type: 'claude_event',
            claudeEventKind: 'assistant_text',
            claudeText: text.length > 200 ? `${text.slice(0, 200)}...` : text,
          });
        }
      } else if (block.type === 'tool_use') {
        entries.push({
          id: randomUUID(),
          taskId,
          timestamp,
          type: 'claude_event',
          claudeEventKind: 'tool_use',
          claudeToolName: block.name as string,
          claudeText: summarizeToolInput(block.name as string, block.input as Record<string, unknown>),
        });
      }
    }

    // Return the first entry; we'll handle multiple blocks by returning all
    // For simplicity, return only the most interesting one per assistant message:
    // prefer text if present, otherwise first tool_use
    return (
      entries.find((e) => e.claudeEventKind === 'assistant_text') ??
      entries.find((e) => e.claudeEventKind === 'tool_use') ??
      null
    );
  }

  return null;
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (!input) return '';
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
      return (input.file_path as string) || '';
    case 'Bash':
      return ((input.command as string) || '').slice(0, 120);
    case 'Glob':
      return (input.pattern as string) || '';
    case 'Grep':
      return `/${(input.pattern as string) || ''}/ ${input.path || ''}`;
    case 'Task':
      return (input.description as string) || '';
    case 'AskUserQuestion': {
      const qs = input.questions as Array<{ question: string }> | undefined;
      return qs?.map((q) => q.question).join('\n') ?? '';
    }
    default:
      return '';
  }
}

function readNewLines(filePath: string, offset: number): { lines: string[]; newOffset: number } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { lines: [], newOffset: offset };
  }

  if (stat.size <= offset) {
    return { lines: [], newOffset: offset };
  }

  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(stat.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);

  const text = buf.toString('utf-8');
  const lines = text.split('\n').filter((l) => l.trim());
  return { lines, newOffset: stat.size };
}

/**
 * Read the tail of a JSONL file and parse the last N entries.
 */
function readRecentEntries(filePath: string, taskId: string, maxEntries: number): ActivityEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n').filter((l) => l.trim());
  // Take only the last maxEntries lines
  const recentLines = lines.slice(-maxEntries);
  const entries: ActivityEntry[] = [];
  for (const line of recentLines) {
    const entry = parseJsonlLine(line, taskId);
    if (entry) entries.push(entry);
  }
  return entries;
}

export interface ClaudeWatcherCallbacks {
  onSummary?: (taskId: string, summary: string) => void;
}

export function startClaudeWatching(
  taskId: string,
  worktreePath: string,
  mainWindow: BrowserWindow,
  callbacks?: ClaudeWatcherCallbacks,
  sessionId?: string,
): void {
  stopClaudeWatching(taskId);

  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);

  const fileOffsets = new Map<string, number>();

  // Determine which files to watch
  const getWatchFiles = (): string[] => {
    if (!fs.existsSync(projectDir)) return [];
    if (sessionId) {
      // Watch only the specific session file
      const filePath = path.join(projectDir, `${sessionId}.jsonl`);
      return fs.existsSync(filePath) ? [filePath] : [];
    }
    // Watch all JSONL files
    try {
      return fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(projectDir, f));
    } catch {
      return [];
    }
  };

  // Initialize offsets for existing files (skip existing content for live streaming)
  for (const filePath of getWatchFiles()) {
    try {
      const stat = fs.statSync(filePath);
      fileOffsets.set(filePath, stat.size);
    } catch {
      /* ignore */
    }
  }

  const pollTimer = setInterval(() => {
    const files = getWatchFiles();

    for (const filePath of files) {
      // For new files not yet tracked, start from end (skip existing content)
      if (!fileOffsets.has(filePath)) {
        try {
          const stat = fs.statSync(filePath);
          fileOffsets.set(filePath, stat.size);
        } catch {
          /* ignore */
        }
        continue;
      }

      const offset = fileOffsets.get(filePath) ?? 0;
      const { lines, newOffset } = readNewLines(filePath, offset);
      fileOffsets.set(filePath, newOffset);

      for (const line of lines) {
        const entry = parseJsonlLine(line, taskId);
        if (entry) {
          mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, entry);
        }
      }

      if (lines.length > 0) {
        const w = watchers.get(taskId);
        if (w) {
          w.lineCount += lines.length;
          const { onSummary } = callbacks ?? {};
          if (onSummary && w.lineCount >= 1 && (w.lastSummaryAt === 0 || w.lineCount - w.lastSummaryAt >= 10)) {
            w.lastSummaryAt = w.lineCount;
            const config = loadConfig();
            summarizeTask(worktreePath, { sessionId: w.sessionId, ollamaModels: config.ollamaModels })
              .then((summary) => {
                if (summary) onSummary(taskId, summary);
              })
              .catch(() => {
                /* ignore */
              });
          }
        }
      }
    }
  }, 1000);

  watchers.set(taskId, { taskId, sessionId, projectDir, fileOffsets, pollTimer, lineCount: 0, lastSummaryAt: 0 });
}

/**
 * Read recent entries from JSONL files for a task.
 * Reads from all JSONL files above a minimum size (to skip failed/empty sessions),
 * merges entries, and returns the most recent ones sorted by timestamp.
 */
export function getRecentClaudeEntries(taskId: string, worktreePath: string): ActivityEntry[] {
  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);

  if (!fs.existsSync(projectDir)) return [];

  const allEntries: ActivityEntry[] = [];
  for (const file of fs.readdirSync(projectDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < 500) continue; // skip empty/failed sessions
      const entries = readRecentEntries(filePath, taskId, 50);
      allEntries.push(...entries);
    } catch {
      /* ignore */
    }
  }

  if (allEntries.length === 0) return [];
  allEntries.sort((a, b) => a.timestamp - b.timestamp);
  return allEntries.slice(-50);
}

export function stopClaudeWatching(taskId: string): void {
  const w = watchers.get(taskId);
  if (w) {
    clearInterval(w.pollTimer);
    watchers.delete(taskId);
  }
}
