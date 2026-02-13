import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import type { ActivityEntry, ClaudeEventKind } from '../shared/types';
import { IPC_STREAM } from '../shared/ipc-channels';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

interface ClaudeWatcher {
  taskId: string;
  projectDir: string;
  /** Byte offset per JSONL file so we only read new lines */
  fileOffsets: Map<string, number>;
  pollTimer: ReturnType<typeof setInterval>;
}

const watchers = new Map<string, ClaudeWatcher>();

/**
 * Derive the Claude projects directory name from a worktree path.
 * Claude Code uses the absolute path with `/` and `.` replaced by `-`.
 */
function projectDirName(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-');
}

function parseJsonlLine(
  line: string,
  taskId: string,
): ActivityEntry | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const type = obj.type as string;
  const timestamp = obj.timestamp
    ? new Date(obj.timestamp as string).getTime()
    : Date.now();

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
      id: uuidv4(),
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
        const text = (block.text as string || '').trim();
        if (text) {
          entries.push({
            id: uuidv4(),
            taskId,
            timestamp,
            type: 'claude_event',
            claudeEventKind: 'assistant_text',
            claudeText: text.length > 200 ? text.slice(0, 200) + '...' : text,
          });
        }
      } else if (block.type === 'tool_use') {
        entries.push({
          id: uuidv4(),
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
    return entries.find((e) => e.claudeEventKind === 'assistant_text')
      ?? entries.find((e) => e.claudeEventKind === 'tool_use')
      ?? null;
  }

  return null;
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  if (!input) return '';
  switch (toolName) {
    case 'Edit':
      return input.file_path as string || '';
    case 'Write':
      return input.file_path as string || '';
    case 'Read':
      return input.file_path as string || '';
    case 'Bash':
      return (input.command as string || '').slice(0, 120);
    case 'Glob':
      return input.pattern as string || '';
    case 'Grep':
      return `/${input.pattern as string || ''}/ ${input.path || ''}`;
    case 'Task':
      return input.description as string || '';
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

export function startClaudeWatching(
  taskId: string,
  worktreePath: string,
  mainWindow: BrowserWindow,
): void {
  stopClaudeWatching(taskId);

  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);

  if (!fs.existsSync(projectDir)) {
    // No Claude project directory yet — we'll poll until it appears
  }

  const fileOffsets = new Map<string, number>();

  // Initialize offsets for existing files (skip existing content)
  if (fs.existsSync(projectDir)) {
    for (const file of fs.readdirSync(projectDir)) {
      if (file.endsWith('.jsonl')) {
        const filePath = path.join(projectDir, file);
        try {
          const stat = fs.statSync(filePath);
          fileOffsets.set(filePath, stat.size);
        } catch { /* ignore */ }
      }
    }
  }

  const pollTimer = setInterval(() => {
    if (!fs.existsSync(projectDir)) return;

    let files: string[];
    try {
      files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return;
    }

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const offset = fileOffsets.get(filePath) ?? 0;

      // For new files (offset 0), skip to end to avoid replaying history
      if (offset === 0 && !fileOffsets.has(filePath)) {
        try {
          const stat = fs.statSync(filePath);
          fileOffsets.set(filePath, stat.size);
        } catch { /* ignore */ }
        continue;
      }

      const { lines, newOffset } = readNewLines(filePath, offset);
      if (newOffset !== offset) {
        fileOffsets.set(filePath, newOffset);
      }

      for (const line of lines) {
        const entry = parseJsonlLine(line, taskId);
        if (entry) {
          mainWindow.webContents.send(IPC_STREAM.ACTIVITY_ENTRY, entry);
        }
      }
    }
  }, 1000);

  watchers.set(taskId, { taskId, projectDir, fileOffsets, pollTimer });
}

export function stopClaudeWatching(taskId: string): void {
  const w = watchers.get(taskId);
  if (w) {
    clearInterval(w.pollTimer);
    watchers.delete(taskId);
  }
}
