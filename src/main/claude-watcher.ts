import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels';
import type {
  ActivityEntry,
  SubagentTokenData,
  TokenDataPoint,
  TokenTurnTool,
  TokenTurnType,
  TokenUsageResult,
} from '../shared/types';
import { loadConfig } from './config';
import { type FsWatchHandle, watchDir } from './fs-watcher';
import { summarizeTask } from './task-summarizer';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

// The filesystem watch drives the low-latency path; this slow poll is a safety
// net (dropped events) and bootstraps the watch once the project dir appears —
// Claude Code creates it lazily after the session starts writing.
const CLAUDE_SAFETY_POLL_MS = 2000;

interface ClaudeWatcher {
  taskId: string;
  sessionId?: string;
  projectDir: string;
  /** Byte offset per JSONL file so we only read new lines */
  fileOffsets: Map<string, number>;
  /** Safety-net poll; the filesystem watch drives the hot path. */
  pollTimer: ReturnType<typeof setInterval>;
  /** Filesystem watch on the project dir, once it exists. */
  fsWatch: FsWatchHandle | null;
  /** Guards against overlapping subscribe() attempts. */
  subscribing: boolean;
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

/** Fuller tool detail for token usage (not truncated like summarizeToolInput) */
function fullToolDetail(toolName: string, input: Record<string, unknown>): string {
  if (!input) return '';
  switch (toolName) {
    case 'Edit':
    case 'Write':
    case 'Read':
      return (input.file_path as string) || '';
    case 'Bash':
      return (input.command as string) || '';
    case 'Glob':
      return (input.pattern as string) || '';
    case 'Grep':
      return `/${(input.pattern as string) || ''}/ ${input.path || ''}`;
    case 'Agent':
      return (input.prompt as string) || (input.description as string) || '';
    case 'Skill':
      return (input.skill as string) || '';
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

/** How far back a tail read looks for the last entry that carries a timestamp. */
const TAIL_BYTES = 64 * 1024;

function lastEntryAt(filePath: string): number | null {
  let chunk: string;
  try {
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'r');
    try {
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
      fs.readSync(fd, buf, 0, buf.length, start);
      chunk = buf.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = chunk.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Transcripts end in records carrying no timestamp — bridge registrations,
    // cost state — so the walk continues back to the last one that has it.
    if (!lines[i].includes('"timestamp"')) continue;
    try {
      const at = Date.parse((JSON.parse(lines[i]) as { timestamp?: string }).timestamp ?? '');
      if (!Number.isNaN(at)) return at;
    } catch {
      /* a torn first line of the window, or a record mid-write */
    }
  }
  return null;
}

/**
 * When a worktree's Claude sessions last said anything. Read from the entries
 * themselves: a file's mtime also moves for bookkeeping no one asked for.
 */
export function lastConversationAt(worktreePath: string): number | null {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, projectDirName(worktreePath));
  let newest: number | null = null;
  try {
    for (const name of fs.readdirSync(projectDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const at = lastEntryAt(path.join(projectDir, name));
      if (at != null && (newest == null || at > newest)) newest = at;
    }
  } catch {
    /* no project directory: this worktree has no sessions */
  }
  return newest;
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

  const w: ClaudeWatcher = {
    taskId,
    sessionId,
    projectDir,
    fileOffsets,
    pollTimer: null as unknown as ReturnType<typeof setInterval>,
    fsWatch: null,
    subscribing: false,
    lineCount: 0,
    lastSummaryAt: 0,
  };

  const processNewLines = (): void => {
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
  };

  // Subscribe to the project dir once it exists. Claude Code creates it lazily,
  // so this is retried from the safety poll until it succeeds.
  const ensureSubscribed = (): void => {
    if (w.fsWatch || w.subscribing || !fs.existsSync(projectDir)) return;
    w.subscribing = true;
    watchDir(projectDir, processNewLines, { debounceMs: 100 })
      .then((handle) => {
        if (watchers.get(taskId) === w) w.fsWatch = handle;
        else void handle.close();
      })
      .catch(() => {
        /* ignore — the safety poll keeps streaming and will retry */
      })
      .finally(() => {
        w.subscribing = false;
      });
  };

  ensureSubscribed();

  // Safety net: catches any dropped events and (re)establishes the watch once
  // the project dir appears. The fs watch handles the low-latency path.
  w.pollTimer = setInterval(() => {
    ensureSubscribed();
    processNewLines();
  }, CLAUDE_SAFETY_POLL_MS);

  watchers.set(taskId, w);
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

/** Parsed JSONL line */
interface ParsedLine {
  type: string;
  timestamp: number;
  // assistant fields
  usage?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  contentType?: string; // 'text' | 'tool_use' | 'thinking'
  toolName?: string;
  toolDetail?: string;
  text?: string;
  // user fields
  userText?: string;
  isToolResult?: boolean;
}

function parseLine(line: string): ParsedLine | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const type = obj.type as string;
  const timestamp = obj.timestamp ? new Date(obj.timestamp as string).getTime() : Date.now();

  if (type === 'assistant') {
    const msg = obj.message as { usage?: Record<string, unknown>; content?: unknown[] } | undefined;
    const content = msg?.content;
    const block = Array.isArray(content) ? (content[0] as Record<string, unknown>) : undefined;
    const contentType = block?.type as string | undefined;

    const usage = msg?.usage;
    const parsed: ParsedLine = { type, timestamp, contentType };

    if (usage) {
      parsed.usage = {
        input: (usage.input_tokens as number) || 0,
        output: (usage.output_tokens as number) || 0,
        cacheRead: (usage.cache_read_input_tokens as number) || 0,
        cacheCreation: (usage.cache_creation_input_tokens as number) || 0,
      };
    }

    if (contentType === 'tool_use' && block) {
      parsed.toolName = block.name as string;
      parsed.toolDetail = fullToolDetail(block.name as string, block.input as Record<string, unknown>) || undefined;
    } else if (contentType === 'text' && block) {
      const text = ((block.text as string) || '').trim();
      if (text) parsed.text = text;
    }

    return parsed;
  }

  if (type === 'user') {
    const msg = obj.message as { content?: unknown } | undefined;
    const content = msg?.content;
    const parsed: ParsedLine = { type, timestamp };

    if (Array.isArray(content)) {
      const blocks = content as Record<string, unknown>[];
      // Check if this is a tool_result
      if (blocks.some((b) => b.type === 'tool_result')) {
        parsed.isToolResult = true;
      } else {
        const textParts = blocks.filter((b) => b.type === 'text').map((b) => (b.text as string) || '');
        if (textParts.length > 0) parsed.userText = textParts.join('\n');
      }
    } else if (typeof content === 'string') {
      parsed.userText = content;
    }

    return parsed;
  }

  if (type === 'system' && (obj.subtype as string) === 'compact_boundary') {
    return { type: 'compact_boundary', timestamp };
  }

  return null;
}

/**
 * Group parsed JSONL lines into logical turns (one API call each).
 * A turn boundary is a user message that is NOT a tool_result.
 * Within a turn, token usage is summed across blocks, and all tool calls / text
 * are collected.
 */
function groupIntoTurns(allLines: ParsedLine[]): TokenDataPoint[] {
  const points: TokenDataPoint[] = [];
  let inPlanMode = false;
  let currentPrompt: string | undefined;
  let turnTimestamp = 0;
  let turnTools: TokenTurnTool[] = [];
  let turnTexts: string[] = [];
  let turnUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let turnHasData = false;
  let turnPlanMode = false;
  let turnHasUserPrompt = false;
  let turnCompacted = false;
  let nextTurnCompacted = false;
  let turnLastSubCallKey = '';
  let turnSubCallMaxOutput = 0;
  let turnSubCallToolStart = 0;
  let turnPrevBlockOutput = 0;
  let turnTextTokens = 0;

  const classifyTurn = (): TokenTurnType => {
    if (turnPlanMode) return 'plan';
    if (!turnHasUserPrompt) return 'agent';
    if (turnTools.length > 0) return 'tool';
    return 'user';
  };

  const flushTurn = () => {
    if (!turnHasData) return;
    turnUsage.output += turnSubCallMaxOutput;
    const totalInput = turnUsage.input + turnUsage.cacheRead + turnUsage.cacheCreation;
    if (totalInput === 0 && turnUsage.output === 0) return;

    const summary = turnTexts.join('\n').trim();
    points.push({
      timestamp: turnTimestamp,
      inputTokens: turnUsage.input,
      outputTokens: turnUsage.output,
      cacheReadTokens: turnUsage.cacheRead,
      cacheCreationTokens: turnUsage.cacheCreation,
      turnType: classifyTurn(),
      tools: turnTools.length > 0 ? turnTools : undefined,
      summary: summary ? (summary.length > 1000 ? `${summary.slice(0, 1000)}...` : summary) : undefined,
      summaryTokens: turnTextTokens || undefined,
      prompt: currentPrompt
        ? currentPrompt.length > 1000
          ? `${currentPrompt.slice(0, 1000)}...`
          : currentPrompt
        : undefined,
      compacted: turnCompacted || undefined,
    });
  };

  const resetTurn = () => {
    turnTimestamp = 0;
    turnTools = [];
    turnTexts = [];
    turnUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    turnHasData = false;
    turnPlanMode = inPlanMode;
    turnHasUserPrompt = false;
    turnCompacted = nextTurnCompacted;
    nextTurnCompacted = false;
    turnLastSubCallKey = '';
    turnSubCallMaxOutput = 0;
    turnSubCallToolStart = 0;
    turnPrevBlockOutput = 0;
    turnTextTokens = 0;
  };

  for (const line of allLines) {
    if (line.type === 'user') {
      if (!line.isToolResult) {
        flushTurn();
        resetTurn();
        currentPrompt = line.userText;
        turnHasUserPrompt = !!line.userText;
      }
      continue;
    }

    if (line.type === 'compact_boundary') {
      nextTurnCompacted = true;
      continue;
    }

    if (line.type === 'assistant') {
      if (!turnHasData) {
        turnTimestamp = line.timestamp;
        turnPlanMode = inPlanMode;
      }
      turnHasData = true;

      let blockOutputDelta = 0;
      if (line.usage) {
        const subCallKey = `${line.usage.input}:${line.usage.cacheRead}:${line.usage.cacheCreation}`;
        if (subCallKey !== turnLastSubCallKey) {
          const newSubCallInput = line.usage.input + line.usage.cacheRead + line.usage.cacheCreation;
          const prevSubCallInput = turnUsage.input + turnUsage.cacheRead + turnUsage.cacheCreation;
          const inputGrowth = Math.max(0, newSubCallInput - prevSubCallInput);

          if (inputGrowth > 0 && turnSubCallToolStart < turnTools.length) {
            const toolCount = turnTools.length - turnSubCallToolStart;
            const perTool = Math.round(inputGrowth / toolCount);
            for (let ti = turnSubCallToolStart; ti < turnTools.length; ti++) {
              turnTools[ti].inputTokens = perTool;
            }
          }
          turnSubCallToolStart = turnTools.length;

          turnUsage.output += turnSubCallMaxOutput;
          turnSubCallMaxOutput = 0;
          turnPrevBlockOutput = 0;
          turnLastSubCallKey = subCallKey;
        }
        const subCallInput = line.usage.input + line.usage.cacheRead + line.usage.cacheCreation;
        if (subCallInput > turnUsage.input + turnUsage.cacheRead + turnUsage.cacheCreation) {
          turnUsage.input = line.usage.input;
          turnUsage.cacheRead = line.usage.cacheRead;
          turnUsage.cacheCreation = line.usage.cacheCreation;
        }
        blockOutputDelta = Math.max(0, line.usage.output - turnPrevBlockOutput);
        turnPrevBlockOutput = line.usage.output;
        turnSubCallMaxOutput = Math.max(turnSubCallMaxOutput, line.usage.output);
      }

      if (line.toolName) {
        if (line.toolName === 'EnterPlanMode') inPlanMode = true;
        else if (line.toolName === 'ExitPlanMode') inPlanMode = false;

        turnTools.push({
          name: line.toolName,
          detail: line.toolDetail,
          outputTokens: blockOutputDelta,
        });
      }

      if (line.text) {
        turnTexts.push(line.text);
        turnTextTokens += blockOutputDelta;
      }
    }
  }

  flushTurn();
  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

/**
 * Convert parsed subagent lines into one data point per API sub-call.
 * Unlike the main session, subagent files have NO non-tool-result user messages,
 * so `groupIntoTurns` collapses everything into a single turn.  Instead, we
 * emit one point per distinct sub-call (identified by input-token signature changes).
 * Each point keeps the max output seen within that sub-call.
 */
function groupSubagentIntoPoints(allLines: ParsedLine[]): TokenDataPoint[] {
  const points: TokenDataPoint[] = [];
  let lastKey = '';

  for (const line of allLines) {
    if (line.type !== 'assistant' || !line.usage) continue;

    const { input, output, cacheRead, cacheCreation } = line.usage;
    const key = `${input}:${cacheRead}:${cacheCreation}`;

    if (key !== lastKey) {
      // New sub-call — create a new point
      const totalIn = input + cacheRead + cacheCreation;
      if (totalIn === 0 && output === 0) continue;
      points.push({
        timestamp: line.timestamp,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheCreationTokens: cacheCreation,
        turnType: 'agent',
      });
      lastKey = key;
    } else if (points.length > 0) {
      // Same sub-call — update output to max
      const last = points[points.length - 1];
      last.outputTokens = Math.max(last.outputTokens, output);
      last.timestamp = line.timestamp; // use latest timestamp
    }
  }

  return points;
}

/** Read all lines from JSONL files and parse them */
function readAndParseLines(files: string[]): ParsedLine[] {
  const allLines: ParsedLine[] = [];
  for (const filePath of files) {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      if (parsed) allLines.push(parsed);
    }
  }
  return allLines;
}

/**
 * Read all token usage data points from JSONL files for a task.
 */
export function getTokenUsageData(worktreePath: string, sessionId?: string): TokenUsageResult {
  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);

  if (!fs.existsSync(projectDir)) return { points: [], subagents: [] };

  const files: string[] = [];
  if (sessionId) {
    const filePath = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(filePath)) files.push(filePath);
  } else {
    try {
      for (const f of fs.readdirSync(projectDir)) {
        if (f.endsWith('.jsonl')) files.push(path.join(projectDir, f));
      }
    } catch {
      return { points: [], subagents: [] };
    }
  }

  // Discover subagent files
  const subagentFiles: { filePath: string; id: string }[] = [];
  if (sessionId) {
    const subagentDir = path.join(projectDir, sessionId, 'subagents');
    try {
      for (const f of fs.readdirSync(subagentDir)) {
        if (!f.endsWith('.jsonl')) continue;
        // Skip agent-acompact-* files — these are continuation segments after
        // context compaction, already represented in the main session JSONL.
        if (f.startsWith('agent-acompact-')) continue;
        subagentFiles.push({
          filePath: path.join(subagentDir, f),
          id: f.replace('.jsonl', ''),
        });
      }
    } catch {
      // No subagents directory
    }
  }

  const allLines = readAndParseLines(files);
  const points = groupIntoTurns(allLines);

  // Parse subagent files
  const subagents: SubagentTokenData[] = [];
  for (const sf of subagentFiles) {
    let slug = sf.id;
    try {
      const content = fs.readFileSync(sf.filePath, 'utf-8');
      const firstLine = content.split('\n').find((l) => l.trim());
      if (firstLine) {
        const obj = JSON.parse(firstLine);
        if (obj.slug) slug = obj.slug as string;
      }
    } catch {
      // Fall back to id as slug
    }

    const subLines = readAndParseLines([sf.filePath]);
    const subPoints = groupSubagentIntoPoints(subLines);
    if (subPoints.length > 0) {
      subagents.push({ id: sf.id, slug, points: subPoints });
    }
  }

  return { points, subagents };
}

export function stopClaudeWatching(taskId: string): void {
  const w = watchers.get(taskId);
  if (w) {
    clearInterval(w.pollTimer);
    void w.fsWatch?.close();
    watchers.delete(taskId);
  }
}
