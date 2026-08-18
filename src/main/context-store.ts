import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CaptureContextParams, ContextEntry, TranscriptContext } from '../shared/types';
import { getDb } from './db';

const MAX_ENTRIES = 200;
const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONTENT_SIZE = 100 * 1024; // 100KB

let nextId = 1;
const entries = new Map<number, ContextEntry>();

// biome-ignore lint/suspicious/noExplicitAny: row objects from SQLite have dynamic fields
type Row = Record<string, any>;

function rowToEntry(row: Row): ContextEntry {
  const base = {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    capturedAt: row.captured_at,
  };

  switch (row.type) {
    case 'terminal':
      return { ...base, type: 'terminal', content: row.content, hasSelection: !!row.has_selection };
    case 'diff':
      return { ...base, type: 'diff', content: row.content };
    case 'activity':
      return { ...base, type: 'activity', content: row.content };
    case 'transcript': {
      const entry: TranscriptContext = {
        ...base,
        type: 'transcript',
        content: row.content,
        jsonlPath: row.jsonl_path,
        lineNumber: row.line_number,
        uuid: row.uuid,
      };
      if (row.selected_text != null) entry.selectedText = row.selected_text;
      if (row.selection_start != null) entry.selectionStart = row.selection_start;
      if (row.selection_end != null) entry.selectionEnd = row.selection_end;
      if (row.resolved_content != null) entry.resolvedContent = row.resolved_content;
      return entry;
    }
    default:
      return { ...base, type: 'diff', content: row.content };
  }
}

function persistEntry(entry: ContextEntry): void {
  const transcript = entry.type === 'transcript' ? (entry as TranscriptContext) : null;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO context_entries (id, task_id, task_name, type, content, captured_at,
      has_selection, jsonl_path, line_number, uuid, selected_text, selection_start, selection_end, resolved_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.id,
      entry.taskId,
      entry.taskName,
      entry.type,
      (entry as { content: string }).content,
      entry.capturedAt,
      entry.type === 'terminal' ? ((entry as { hasSelection: boolean }).hasSelection ? 1 : 0) : null,
      transcript?.jsonlPath ?? null,
      transcript?.lineNumber ?? null,
      transcript?.uuid ?? null,
      transcript?.selectedText ?? null,
      transcript?.selectionStart ?? null,
      transcript?.selectionEnd ?? null,
      transcript?.resolvedContent ?? null,
    );
}

function truncateContent(content: string): string {
  return content.length > MAX_CONTENT_SIZE ? `${content.slice(0, MAX_CONTENT_SIZE)}\n... (truncated)` : content;
}

export function store(params: CaptureContextParams): number {
  cleanup();

  const id = nextId++;
  const base = {
    id,
    taskId: params.taskId,
    taskName: params.taskName,
    capturedAt: Date.now(),
  };

  let entry: ContextEntry;

  switch (params.type) {
    case 'terminal':
      entry = {
        ...base,
        type: 'terminal',
        content: truncateContent(params.content),
        hasSelection: params.hasSelection,
      };
      break;
    case 'diff':
      entry = { ...base, type: 'diff', content: truncateContent(params.content) };
      break;
    case 'activity':
      entry = { ...base, type: 'activity', content: truncateContent(params.content) };
      break;
    case 'transcript':
      entry = {
        ...base,
        type: 'transcript',
        content: truncateContent(params.content),
        jsonlPath: params.jsonlPath,
        lineNumber: params.lineNumber,
        uuid: params.uuid,
        selectedText: params.selectedText,
        selectionStart: params.selectionStart,
        selectionEnd: params.selectionEnd,
      };
      break;
  }

  entries.set(id, entry);
  persistEntry(entry);

  // Evict oldest if over limit
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  return id;
}

export function resolve(id: number): ContextEntry | null {
  cleanup();
  const entry = entries.get(id) ?? null;
  if (!entry) return null;

  // For transcript entries, resolve content from JSONL at read time
  if (entry.type === 'transcript') {
    return resolveTranscript(entry);
  }

  return entry;
}

function resolveTranscript(entry: TranscriptContext): ContextEntry | null {
  try {
    if (!fs.existsSync(entry.jsonlPath)) return entry;

    const data = fs.readFileSync(entry.jsonlPath, 'utf-8');
    const lines = data.split('\n').filter((l) => l.trim());

    if (entry.lineNumber < 0 || entry.lineNumber >= lines.length) return entry;

    const parsed = JSON.parse(lines[entry.lineNumber]);

    // Verify UUID matches
    if (parsed.uuid !== entry.uuid) return entry;

    // Extract text content from the JSONL entry
    const content = extractTranscriptContent(parsed);
    if (!content) return entry;

    return {
      ...entry,
      resolvedContent: content,
    };
  } catch {
    return entry;
  }
}

function extractTranscriptContent(parsed: Record<string, unknown>): string | null {
  // Claude session JSONL entries have a `message` field with `content` array
  if (parsed.message && typeof parsed.message === 'object') {
    const message = parsed.message as Record<string, unknown>;
    if (Array.isArray(message.content)) {
      const textParts = (message.content as Array<Record<string, unknown>>)
        .filter((c) => c.type === 'text')
        .map((c) => c.text as string);
      return textParts.join('\n') || null;
    }
  }
  // Fallback: try top-level content
  if (typeof parsed.content === 'string') return parsed.content;
  return null;
}

/** Find the Claude session JSONL path from a worktree path */
export function getClaudeJsonlPath(worktreePath: string): string | null {
  // ~/.claude/projects/ uses path with / replaced by -
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return null;

  // Convert worktree path to the key format Claude uses: leading / removed, remaining / → -
  const projectKey = worktreePath.replace(/^\//, '').replace(/\//g, '-');
  const projectDir = path.join(projectsDir, projectKey);

  if (!fs.existsSync(projectDir)) return null;

  // Find the most recently modified .jsonl file
  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({
        name: f,
        path: path.join(projectDir, f),
        mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}

/** Search a Claude session JSONL for an assistant entry matching terminal text */
export function findTranscriptMatch(
  jsonlPath: string,
  searchText: string,
): { lineNumber: number; uuid: string } | null {
  try {
    const data = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = data.split('\n').filter((l) => l.trim());

    // Search backwards (most recent first) for assistant messages
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.type !== 'assistant') continue;

        const content = extractTranscriptContent(parsed);
        if (!content) continue;

        // Strip markdown for comparison with terminal text
        const stripped = stripMarkdown(content);

        if (stripped.includes(searchText) || fuzzyContains(stripped, searchText)) {
          return { lineNumber: i, uuid: parsed.uuid };
        }
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip basic markdown formatting to approximate terminal-rendered text */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1') // **bold**
    .replace(/\*(.+?)\*/g, '$1') // *italic*
    .replace(/__(.+?)__/g, '$1') // __bold__
    .replace(/_(.+?)_/g, '$1') // _italic_
    .replace(/`([^`]+)`/g, '$1') // `code`
    .replace(/```[\s\S]*?```/g, '') // code blocks
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/^\s*[-*+]\s+/gm, '') // list markers
    .replace(/^\s*\d+\.\s+/gm, '') // numbered lists
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // links
}

/** Fuzzy match: check if a substantial substring of searchText appears in text */
function fuzzyContains(text: string, searchText: string): boolean {
  // Try with a distinctive 40-char window from the middle of searchText
  const trimmed = searchText.trim();
  if (trimmed.length < 20) return false;
  const mid = Math.floor(trimmed.length / 2);
  const windowSize = Math.min(40, trimmed.length);
  const start = Math.max(0, mid - Math.floor(windowSize / 2));
  const window = trimmed.slice(start, start + windowSize);
  return text.includes(window);
}

export function loadPersistedContexts(): void {
  const now = Date.now();
  const rows = getDb()
    .prepare<unknown[], Row>('SELECT * FROM context_entries WHERE captured_at > ?')
    .all(now - TTL_MS);
  for (const row of rows) {
    const entry = rowToEntry(row);
    entries.set(entry.id, entry);
    if (entry.id >= nextId) nextId = entry.id + 1;
  }

  // Clean up expired entries in DB
  getDb()
    .prepare('DELETE FROM context_entries WHERE captured_at < ?')
    .run(now - TTL_MS);
}

function cleanup(): void {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (now - entry.capturedAt > TTL_MS) {
      entries.delete(id);
    }
  }
}
