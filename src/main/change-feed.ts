import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { structuredPatch } from 'diff';
import type { FeedChange, FeedHunk, FeedItem } from '../shared/types.ts';

/** A one-line rendering of a tool call's input, for feed ticks and activity rows. */
export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
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
    case 'SendMessage':
      return (input.to as string) || '';
    case 'AskUserQuestion': {
      const qs = input.questions as Array<{ question: string }> | undefined;
      return qs?.map((q) => q.question).join('\n') ?? '';
    }
    default:
      return '';
  }
}

/**
 * Git commands that move the working tree wholesale. What they leave on disk is
 * not an edit anyone narrated, so the feed re-baselines instead of drawing it.
 * `apply` and `commit` are absent on purpose: one writes content the agent
 * authored, the other writes none.
 */
const GIT_BULK = /\bgit\s+(?:-\S+\s+)*(checkout|switch|restore|stash|reset|revert|rebase|merge|pull|clean)\b/;

/** Whether a shell command's effect on the worktree should go unreported. */
export function movesTreeWholesale(command: string): boolean {
  return GIT_BULK.test(command);
}

/**
 * Files that change as a side effect of work rather than as the work itself.
 * A lockfile or a build artefact is a consequence of the edit above it.
 */
export const DEFAULT_IGNORE = [
  '**/*.lock',
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/Cargo.lock',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/target/**',
  '**/node_modules/**',
  '**/coverage/**',
  '**/__snapshots__/**',
  '**/*.min.js',
  '**/*.map',
];

/** Whether a worktree-relative path matches any glob. Supports `**`, `*` and `?`. */
export function isIgnored(relPath: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(relPath));
}

const globCache = new Map<string, RegExp>();

function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` also matches nothing, so a leading one covers the repo root.
        out += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += glob[i + 2] === '/' ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
  }
  const re = new RegExp(`^${out}$`);
  globCache.set(glob, re);
  return re;
}

/** Tools whose result carries a file change; everything else becomes a tick. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Lines of diff a card renders before it is cut short. */
const MAX_CARD_LINES = 200;

/** Lines of context around each hunk — one, because the dock is narrow. */
export const DIFF_CONTEXT = 1;

interface EditResult {
  filePath?: string;
  originalFile?: string;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  content?: string;
  type?: string;
  structuredPatch?: { newStart: number; lines: string[] }[];
}

/** One file's worth of `git diff-tree -p` output. */
export interface FileDiff {
  filePath: string;
  hunks: FeedHunk[];
  added: number;
  removed: number;
  created: boolean;
  /** The post-image blob id. */
  blobSha: string;
}

export type FeedEvent =
  | { kind: 'text'; ts: number; uuid: string; text: string; thinking?: boolean }
  | { kind: 'tool'; ts: number; id: string; name: string; input: Record<string, unknown>; agentLabel?: string }
  | { kind: 'result'; ts: number; id: string; result: EditResult; agentLabel?: string }
  | ({ kind: 'fs'; ts: number; id: string; command: string } & FileDiff)
  /** A backgrounded command finished; `id` is the tool call that started it. */
  | { kind: 'bgdone'; ts: number; id: string };

/**
 * A subagent contributes its file changes and nothing else: its reads, greps and
 * shell calls run at a volume that would bury the session's own feed.
 */
export function changeEventsOnly(events: FeedEvent[], agentLabel: string): FeedEvent[] {
  return events
    .filter((e) => (e.kind === 'tool' && EDIT_TOOLS.has(e.name)) || e.kind === 'result')
    .map((e) => (e.kind === 'text' ? e : { ...e, agentLabel }));
}

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const INDEX_LINE = /^index [0-9a-f]+\.\.([0-9a-f]+)/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)/;

/**
 * Split `git diff-tree -p` into one entry per file. Entries git reports without
 * a patch — binaries, and renames that changed nothing — carry no hunks and are
 * dropped by the caller, having nothing to show.
 */
export function parseDiffTree(output: string, worktreePath: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: FeedHunk | null = null;

  const closeHunk = () => {
    if (current && hunk && hunk.lines.length > 0) current.hunks.push(hunk);
    hunk = null;
  };

  for (const line of output.split('\n')) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      closeHunk();
      current = {
        filePath: path.resolve(worktreePath, header[2]),
        hunks: [],
        added: 0,
        removed: 0,
        created: false,
        blobSha: '',
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.created = true;
      continue;
    }
    const index = INDEX_LINE.exec(line);
    if (index) {
      current.blobSha = index[1];
      continue;
    }
    const hunkHeader = HUNK_HEADER.exec(line);
    if (hunkHeader) {
      closeHunk();
      hunk = { newStart: Number(hunkHeader[1]), lines: [] };
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('+')) current.added++;
    else if (line.startsWith('-')) current.removed++;
    else if (!line.startsWith(' ')) continue;
    hunk.lines.push(line);
  }
  closeHunk();

  return files.filter((f) => f.hunks.length > 0);
}

/**
 * Flatten transcript lines into the events the fold consumes. Assistant text and
 * tool calls arrive on `assistant` records, tool results on `user` records.
 */
export function parseFeedLines(lines: string[]): FeedEvent[] {
  const events: FeedEvent[] = [];

  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = obj.timestamp ? new Date(obj.timestamp as string).getTime() : Date.now();
    const uuid = (obj.uuid as string) || `${ts}`;
    const content = (obj.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;

    if (obj.type === 'assistant') {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'text' || block.type === 'thinking') {
          // Most thinking blocks carry only a signature; the rest are the short
          // note explaining the call that follows, and read as narration.
          const thinking = block.type === 'thinking';
          const text = (((thinking ? block.thinking : block.text) as string) || '').trim();
          if (text) events.push({ kind: 'text', ts, uuid, text, thinking });
        } else if (block.type === 'tool_use') {
          events.push({
            kind: 'tool',
            ts,
            id: block.id as string,
            name: block.name as string,
            input: (block.input as Record<string, unknown>) ?? {},
          });
        }
      }
    } else if (obj.type === 'user' && !obj.toolUseResult) {
      // A backgrounded command's tool result lands at once; this is the record
      // that says the work behind it is over.
      const text = content.map((b) => (b as { text?: string }).text ?? '').join('');
      const done = /<task-notification>[\s\S]*?<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text);
      if (done) events.push({ kind: 'bgdone', ts, id: done[1].trim() });
    } else if (obj.type === 'user' && obj.toolUseResult) {
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === 'tool_result') {
          events.push({ kind: 'result', ts, id: block.tool_use_id as string, result: obj.toolUseResult as EditResult });
        }
      }
    }
  }

  return events;
}

function applyEdit(original: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (replaceAll) return original.split(oldString).join(newString);
  const at = original.indexOf(oldString);
  return at < 0 ? original : original.slice(0, at) + newString + original.slice(at + oldString.length);
}

/** The file's content after this edit, or null when the result does not say. */
function contentAfter(r: EditResult): string | null {
  if (typeof r.content === 'string') return r.content;
  if (typeof r.originalFile === 'string' && typeof r.oldString === 'string' && typeof r.newString === 'string') {
    return applyEdit(r.originalFile, r.oldString, r.newString, r.replaceAll === true);
  }
  return null;
}

/** Agents edit outside the worktree too, and a chain of '..' reads as nothing. */
function displayPath(filePath: string, worktreePath: string): string {
  const rel = path.relative(worktreePath, filePath);
  if (rel && !rel.startsWith('..')) return rel;
  const home = os.homedir();
  return filePath.startsWith(`${home}/`) ? `~/${filePath.slice(home.length + 1)}` : filePath;
}

/** A command's own path, before the `&&` that carries the work. */
const LEADING_CD = /^\s*cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*(?:&&|;)\s*/;

/**
 * What a command reads as in a dock a few hundred pixels wide. Agents open with
 * `cd <worktree> && …`, which is the same prefix on every one of them and long
 * enough to crowd out the part that differs.
 */
export function commandLabel(command: string, worktreePath: string): string {
  const withoutCd = command.replace(LEADING_CD, '');
  const body = withoutCd.trim() === '' ? command : withoutCd;
  return shorten(body.replace(/\s*\n\s*/g, ' ').trim(), worktreePath);
}

/** Paths inside the worktree show relative, so a tick fits the dock's width. */
function shorten(detail: string, worktreePath: string): string {
  return detail.startsWith(`${worktreePath}/`) ? detail.slice(worktreePath.length + 1) : detail;
}

/** Git's blob id for a string, so a reconstructed file compares against a scan. */
export function blobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf-8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** jsdiff marks a missing trailing newline with a line the feed has no use for. */
const isMarker = (l: string) => l.startsWith('\\');

interface Group {
  firstId: string;
  agentLabel?: string;
  /** The shell command a worktree-found change appeared under. */
  command?: string;
  /** Where the card sits in `items`; later edits rewrite it in place. */
  index: number;
  timestamp: number;
  filePath: string;
  base: string | null;
  after: string | null;
  created: boolean;
  editCount: number;
  /** The hunks the tool results carried. */
  reported: FeedHunk[];
  /** A diff git produced, which stands as the card's contents when present. */
  given: { hunks: FeedHunk[]; added: number; removed: number } | null;
}

function renderGroup(g: Group, taskId: string, worktreePath: string): FeedChange {
  // The reported hunks stand in when the content cannot be reconstructed, and
  // when reconstruction comes out empty because an edit's oldString no longer
  // matched the file it was recorded against.
  let hunks: FeedHunk[] = g.given?.hunks ?? [];
  if (hunks.length === 0 && g.base !== null && g.after !== null) {
    hunks = structuredPatch('a', 'b', g.base, g.after, '', '', { context: DIFF_CONTEXT }).hunks.map((h) => ({
      newStart: h.newStart,
      lines: h.lines.filter((l) => !isMarker(l)),
    }));
  }
  if (hunks.length === 0) hunks = g.reported;

  let added = 0;
  let removed = 0;
  let budget = MAX_CARD_LINES;
  let truncated = false;
  const kept: FeedHunk[] = [];

  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
    if (budget <= 0) {
      truncated = true;
      continue;
    }
    kept.push({ newStart: h.newStart, lines: h.lines.slice(0, budget) });
    if (h.lines.length > budget) truncated = true;
    budget -= h.lines.length;
  }

  return {
    kind: 'change',
    id: `change:${g.firstId}`,
    taskId,
    timestamp: g.timestamp,
    filePath: g.filePath,
    relPath: displayPath(g.filePath, worktreePath),
    hunks: kept,
    added: g.given?.added ?? added,
    removed: g.given?.removed ?? removed,
    editCount: g.editCount,
    created: g.created,
    truncated,
    agentLabel: g.agentLabel,
    command: g.command,
  };
}

/**
 * Fold events into feed items. A change card merges consecutive edits to one
 * file; an edit to a different file or a new narration block starts a new card,
 * so the text explaining a change always sits above it.
 */
export function foldFeed(events: FeedEvent[], opts: { taskId: string; worktreePath: string }): FeedItem[] {
  const { taskId, worktreePath } = opts;
  const toolNames = new Map<string, string>();
  for (const e of events) if (e.kind === 'tool') toolNames.set(e.id, e.name);

  const items: FeedItem[] = [];
  let group: Group | null = null;
  /** The blob each file has been shown to hold, so a repeat assertion is silent. */
  const shaByFile = new Map<string, string>();

  // A card is pushed when its first edit lands and rewritten as later edits merge
  // in, so a change shows up while the agent is still working on the file.
  const restate = (g: Group) => {
    items[g.index] = renderGroup(g, taskId, worktreePath);
  };

  for (const e of events) {
    if (e.kind === 'text') {
      group = null;
      items.push({
        kind: 'narration',
        id: `narration:${e.uuid}`,
        taskId,
        timestamp: e.ts,
        text: e.text,
        thinking: e.thinking,
      });
      continue;
    }

    if (e.kind === 'tool') {
      if (EDIT_TOOLS.has(e.name)) continue;
      const last = items[items.length - 1];
      if (last?.kind === 'tick' && last.tool === e.name) {
        last.count++;
        continue;
      }
      items.push({
        kind: 'tick',
        id: `tick:${e.id}`,
        taskId,
        timestamp: e.ts,
        tool: e.name,
        detail:
          e.name === 'Bash'
            ? commandLabel(String(e.input.command ?? ''), worktreePath)
            : shorten(summarizeToolInput(e.name, e.input), worktreePath),
        count: 1,
      });
      continue;
    }

    // Only the service's attribution cares that a background command ended.
    if (e.kind === 'bgdone') continue;

    const agentLabel = e.kind === 'fs' ? undefined : e.agentLabel;
    let assertion: {
      id: string;
      filePath: string;
      before: string | null;
      after: string | null;
      created: boolean;
      reported: FeedHunk[];
      given: Group['given'];
      sha: string | null;
      command?: string;
    };

    if (e.kind === 'fs') {
      assertion = {
        id: e.id,
        filePath: e.filePath,
        before: null,
        after: null,
        created: e.created,
        reported: [],
        given: { hunks: e.hunks, added: e.added, removed: e.removed },
        sha: e.blobSha,
        command: e.command ? commandLabel(e.command, worktreePath) : undefined,
      };
    } else {
      const name = toolNames.get(e.id);
      if (!name || !EDIT_TOOLS.has(name)) continue;
      if (!e.result.filePath) continue;
      const created = e.result.type === 'create';
      const after = contentAfter(e.result);
      assertion = {
        id: e.id,
        filePath: e.result.filePath,
        // A create reports no originalFile and no patch, so the empty file is the base.
        before: typeof e.result.originalFile === 'string' ? e.result.originalFile : created ? '' : null,
        after,
        created,
        reported: (e.result.structuredPatch ?? []).map((h) => ({
          newStart: h.newStart,
          lines: h.lines.filter((l) => !isMarker(l)),
        })),
        given: null,
        sha: after === null ? null : blobSha(after),
      };
    }

    // A tool result and the scan that follows it both describe the same write.
    // Whichever lands first draws the card; the other names content already shown.
    if (assertion.sha !== null) {
      if (shaByFile.get(assertion.filePath) === assertion.sha) continue;
      shaByFile.set(assertion.filePath, assertion.sha);
    }

    if (group && group.filePath === assertion.filePath && group.agentLabel === agentLabel) {
      group.after = assertion.after;
      group.editCount++;
      group.reported = [...group.reported, ...assertion.reported];
      if (assertion.given) group.given = assertion.given;
      group.command = group.command ?? assertion.command;
      restate(group);
      continue;
    }

    group = {
      firstId: assertion.id,
      agentLabel,
      command: assertion.command,
      index: items.length,
      timestamp: e.ts,
      filePath: assertion.filePath,
      base: assertion.before,
      after: assertion.after,
      created: assertion.created,
      editCount: 1,
      reported: assertion.reported,
      given: assertion.given,
    };
    items.push(renderGroup(group, taskId, worktreePath));
  }

  return items;
}
