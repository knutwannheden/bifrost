import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BrowserWindow } from 'electron';
import { IPC_STREAM } from '../shared/ipc-channels.ts';
import type { FeedChange, FeedItem } from '../shared/types.ts';
import {
  changeEventsOnly,
  DEFAULT_IGNORE,
  DIFF_CONTEXT,
  type FeedEvent,
  foldFeed,
  isIgnored,
  movesTreeWholesale,
  parseDiffTree,
  parseFeedLines,
} from './change-feed.ts';
import { loadConfig } from './config.ts';

const execFile = promisify(execFileCb);

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const GIT_TIMEOUT_MS = 5000;

/** A diff past this is a bulk rewrite, not something the feed can usefully show. */
const MAX_DIFF_BYTES = 4 * 1024 * 1024;

/** How long after a tree-moving git command its fallout keeps arriving. */
const QUIET_MS = 4000;

/**
 * How long after a command exits its writes can still surface. The scan runs on
 * a poll, so a change is noticed some time after it lands.
 */
const ATTRIBUTION_GRACE_MS = 6000;

/** Retained filesystem events, which each hold a whole file's diff. */
const MAX_FS_EVENTS = 60;

/**
 * Transcript read when a task's panel first opens. Two megabytes covers all but
 * the largest transcripts whole, and yields more than the item cap even on one
 * whose lines each carry a file's contents.
 */
const BACKFILL_BYTES = 2 * 1024 * 1024;

/** Events retained per task; older ones fall off the top of the feed. */
const MAX_EVENTS = 3000;

/** Items handed to the renderer, newest last. */
const MAX_ITEMS = 200;

/** Characters of a subagent's opening prompt kept as its label. */
const LABEL_CHARS = 40;

interface Buffered {
  worktreePath: string;
  sessionId?: string;
  events: FeedEvent[];
  /** Bytes already read from each subagent transcript. */
  subagentOffsets: Map<string, number>;
  /** Labels, keyed by subagent file, resolved once when the file appears. */
  subagentLabels: Map<string, string>;
  /** Skill names the session logged for the agents it forked, by agent id. */
  skillNames: Map<string, string>;
  /** The tree a file with no card of its own is measured from. */
  baseTree: string | null;
  /**
   * The tree each open card is measured from. A card holds while its file keeps
   * changing, so every scan carries the file's whole change rather than the
   * sliver since the last one, and the newest report can stand for the card.
   */
  fileBase: Map<string, string>;
  /** Narration closed every card, so the next change is measured from here. */
  repin: boolean;
  /** Cards recovered from the journal, which the live ones are added to. */
  journalled: FeedChange[];
  /**
   * A private object store and index for the snapshots. Writing them into the
   * repository would leave a blob and a tree per directory behind on every scan,
   * unreachable from any ref and so kept by `gc` for its two-week prune window.
   */
  scratch: string;
  /** The repository's own objects, readable so unchanged blobs are not rewritten. */
  alternates: string | null;
  /** Guards against a slow scan overlapping the next poll. */
  scanning: boolean;
  /** Whether the transcript's tail has been read into this task's feed. */
  backfilled: boolean;
  /** Until when a scan only re-baselines, because git is moving the tree. */
  quietUntil: number;
  /** HEAD as of the last scan; a move means every baseline is stale. */
  headSha: string | null;
  /** When each shell command ran, so a change found on disk can name one. */
  bashRuns: Map<string, { command: string; start: number; end?: number; background?: boolean }>;
}

let feedWindow: BrowserWindow | null = null;

/** Only the task whose panel is open scans its worktree, which costs git a walk. */
let activeTaskId: string | null = null;

export function initChangeFeed(win: BrowserWindow): void {
  feedWindow = win;
  // No feed outlives a restart, so neither should the snapshots behind one.
  fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}

export function setActiveFeedTask(taskId: string | null): void {
  activeTaskId = taskId;
}

const SCRATCH_ROOT = path.join(os.tmpdir(), 'bifrost-feed');

/**
 * Worktree-derived cards, kept beside the task rather than in the database:
 * they are the four fifths of a task's diffs the transcript cannot recover, and
 * they live and die with the task that made them.
 */
const JOURNAL_ROOT = path.join(os.homedir(), '.bifrost', 'feed');

/**
 * A snapshot leaves about twenty kilobytes behind, and only the trees the open
 * cards are measured from are ever read again. Past this the store is dropped
 * and the next scan takes the worktree afresh.
 */
const MAX_SCRATCH_BYTES = 64 * 1024 * 1024;

const buffers = new Map<string, Buffered>();

async function capScratch(buf: Buffered): Promise<void> {
  let size = 0;
  try {
    for (const entry of fs.readdirSync(path.join(buf.scratch, 'objects'), { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) size += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    }
  } catch {
    return;
  }
  if (size < MAX_SCRATCH_BYTES) return;
  // Only the trees the open cards measure from are ever read again, so the store
  // is dropped whole and the next scan takes the worktree as it stands.
  fs.rmSync(buf.scratch, { recursive: true, force: true });
  buf.baseTree = null;
  buf.fileBase.clear();
}

/** The env that keeps a snapshot's objects out of the repository. */
function gitEnv(buf: Buffered): NodeJS.ProcessEnv {
  fs.mkdirSync(path.join(buf.scratch, 'objects'), { recursive: true });
  return {
    ...process.env,
    GIT_INDEX_FILE: path.join(buf.scratch, 'index'),
    GIT_OBJECT_DIRECTORY: path.join(buf.scratch, 'objects'),
    ...(buf.alternates ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: buf.alternates } : {}),
  };
}

/** The repository's object store, which a linked worktree shares with its main checkout. */
async function findAlternates(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      'git',
      ['--no-optional-locks', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: worktreePath, timeout: GIT_TIMEOUT_MS },
    );
    const common = stdout.trim();
    return common ? path.join(common, 'objects') : null;
  } catch {
    return null;
  }
}

function newBuffer(taskId: string, worktreePath: string, sessionId?: string): Buffered {
  return {
    worktreePath,
    sessionId,
    events: [],
    subagentOffsets: new Map(),
    subagentLabels: new Map(),
    skillNames: new Map(),
    baseTree: null,
    fileBase: new Map(),
    repin: false,
    journalled: [],
    scratch: path.join(SCRATCH_ROOT, taskId),
    alternates: null,
    scanning: false,
    backfilled: false,
    quietUntil: 0,
    headSha: null,
    bashRuns: new Map(),
  };
}

function projectDirFor(worktreePath: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, worktreePath.replace(/[/.]/g, '-'));
}

/** The transcript this task's feed follows: its session, or the newest one. */
function transcriptFile(worktreePath: string, sessionId?: string): string | null {
  const dir = projectDirFor(worktreePath);
  if (sessionId) {
    const p = path.join(dir, `${sessionId}.jsonl`);
    return fs.existsSync(p) ? p : null;
  }
  try {
    let newest: { p: string; at: number } | null = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = path.join(dir, f);
      const at = fs.statSync(p).mtimeMs;
      if (!newest || at > newest.at) newest = { p, at };
    }
    return newest?.p ?? null;
  } catch {
    return null;
  }
}

function subagentFiles(buf: Buffered): string[] {
  if (!buf.sessionId) return [];
  const dir = path.join(projectDirFor(buf.worktreePath), buf.sessionId, 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl') && !f.startsWith('agent-acompact-'))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/** The session records a skill name for each agent it forks; ordinary Agent calls leave none. */
function collectSkillNames(lines: string[], into: Map<string, string>): void {
  for (const line of lines) {
    if (!line.includes('forked-skill-launch')) continue;
    const m = line.match(/<forked-skill-launch>(\{.*?\})/);
    if (!m) continue;
    try {
      const launch = JSON.parse(m[1].replace(/\\"/g, '"')) as { agentId?: string; skillName?: string };
      if (launch.agentId && launch.skillName) into.set(launch.agentId, launch.skillName);
    } catch {
      /* a launch record we cannot read leaves the agent labelled by its prompt */
    }
  }
}

/**
 * The first line of prose in a prompt. Agents are dispatched with a leading XML
 * envelope, a fenced block or a heading as often as with a sentence, and none of
 * those name the job.
 */
function firstProse(text: string): string | null {
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/<[^>]*>?/g, '')
      .replace(/[`#*_>]/g, '')
      .trim();
    if (line.length >= 8) return line.slice(0, LABEL_CHARS);
  }
  return null;
}

/** A subagent's own opening prompt, which is the only description its file holds. */
function promptLabel(lines: string[]): string | null {
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
      if (obj.type !== 'user') continue;
      const c = obj.message?.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? (c.find((b) => (b as { type?: string }).type === 'text') as { text?: string } | undefined)?.text
            : undefined;
      const first = firstProse(text ?? '');
      if (first) return first;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function labelFor(buf: Buffered, file: string, lines: string[]): string {
  const cached = buf.subagentLabels.get(file);
  if (cached) return cached;
  const agentId = path.basename(file).slice('agent-'.length, -'.jsonl'.length);
  const label = buf.skillNames.get(agentId) ?? promptLabel(lines) ?? agentId.slice(0, 8);
  buf.subagentLabels.set(file, label);
  return label;
}

function readFrom(file: string, offset: number): { lines: string[]; end: number } {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { lines: [], end: offset };
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      return { lines: buf.toString('utf-8').split('\n').filter(Boolean), end: size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { lines: [], end: offset };
  }
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** The last whole lines of a file, at most `cap` bytes of it. */
function tail(file: string, cap: number): string[] {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return [];
  }
  const from = Math.max(0, size - cap);
  const { lines } = readFrom(file, from);
  // A read starting mid-file lands mid-line, and half a record is not JSON.
  return from > 0 ? lines.slice(1) : lines;
}

/** New change events from every subagent transcript, each stamped with its label. */
function pullSubagents(buf: Buffered): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const file of subagentFiles(buf)) {
    const offset = buf.subagentOffsets.get(file);
    // An agent whose file is first seen already large gets its tail, as the
    // session's own transcript does.
    const { lines, end } =
      offset === undefined ? { lines: tail(file, BACKFILL_BYTES), end: fileSize(file) } : readFrom(file, offset);
    buf.subagentOffsets.set(file, end);
    if (lines.length === 0) continue;
    out.push(...changeEventsOnly(parseFeedLines(lines), labelFor(buf, file, lines)));
  }
  return out;
}

/**
 * Record when each shell command ran, and extend the quiet window for the ones
 * that move the tree. Subagent commands count too: their writes reach the same
 * worktree.
 */
function noteCommands(events: FeedEvent[], buf: Buffered): void {
  for (const e of events) {
    if (e.kind === 'bgdone') {
      const run = buf.bashRuns.get(e.id);
      if (run) run.end = e.ts;
      continue;
    }
    if (e.kind === 'result') {
      const run = buf.bashRuns.get(e.id);
      // A backgrounded command returns at once and keeps writing; its own
      // completion notice closes it instead.
      if (run && !run.background) run.end = e.ts;
      continue;
    }
    // Narration is where a change card ends, and where the next one starts.
    if (e.kind === 'text') {
      buf.repin = true;
      continue;
    }
    if (e.kind !== 'tool' || e.name !== 'Bash') continue;
    const command = String(e.input.command ?? '');
    buf.bashRuns.set(e.id, { command, start: e.ts, background: e.input.run_in_background === true });
    if (movesTreeWholesale(command)) buf.quietUntil = Date.now() + QUIET_MS;
  }
  // The map only serves attribution, which reaches back one grace window. A
  // command still running has no end and stays however long it takes.
  const stale = Date.now() - ATTRIBUTION_GRACE_MS * 10;
  for (const [id, run] of buf.bashRuns) {
    if (run.end !== undefined && run.end < stale) buf.bashRuns.delete(id);
    else if (run.end === undefined && !run.background && run.start < stale) buf.bashRuns.delete(id);
  }
}

/** The shell command a change found at `at` can be laid at the door of, if any. */
function commandRunningAt(buf: Buffered, at: number): string | null {
  let best: { command: string; start: number } | null = null;
  for (const run of buf.bashRuns.values()) {
    if (run.start > at) continue;
    if (run.end !== undefined && at > run.end + ATTRIBUTION_GRACE_MS) continue;
    if (!best || run.start > best.start) best = run;
  }
  return best?.command ?? null;
}

async function headSha(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFile('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], {
      cwd: worktreePath,
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Record the worktree as a git tree. A throwaway index keeps this clear of the
 * user's own staging area, and git's stat cache does the walk.
 */
async function snapshotTree(buf: Buffered): Promise<string | null> {
  if (buf.alternates === null) buf.alternates = await findAlternates(buf.worktreePath);
  const env = gitEnv(buf);
  try {
    await execFile('git', ['--no-optional-locks', 'add', '-A'], {
      cwd: buf.worktreePath,
      timeout: GIT_TIMEOUT_MS,
      env,
    });
    const { stdout } = await execFile('git', ['--no-optional-locks', 'write-tree'], {
      cwd: buf.worktreePath,
      timeout: GIT_TIMEOUT_MS,
      env,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** What changed between two snapshots, as git renders it, for the given paths. */
async function diffTrees(buf: Buffered, from: string, to: string, paths: string[]) {
  try {
    const { stdout } = await execFile(
      'git',
      [
        '--no-optional-locks',
        'diff-tree',
        '-p',
        '--find-renames',
        `--unified=${DIFF_CONTEXT}`,
        from,
        to,
        '--',
        ...paths,
      ],
      { cwd: buf.worktreePath, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES, env: gitEnv(buf) },
    );
    return parseDiffTree(stdout, buf.worktreePath);
  } catch {
    return [];
  }
}

/** Which paths differ between two snapshots. `-r` because a tree diff stops at directories. */
async function changedPaths(buf: Buffered, from: string, to: string): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      'git',
      ['--no-optional-locks', 'diff-tree', '-r', '--name-only', '--find-renames', from, to],
      { cwd: buf.worktreePath, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_DIFF_BYTES, env: gitEnv(buf) },
    );
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Report what the worktree holds now. An agent that writes through the shell
 * leaves nothing in the transcript, so git is the only account of those edits;
 * the fold drops whatever a tool result already described.
 */
async function scanWorktree(taskId: string, buf: Buffered): Promise<void> {
  if (buf.scanning) return;
  buf.scanning = true;
  try {
    // A commit or checkout re-points HEAD, which the baseline was taken
    // against, so it is retaken rather than diffed.
    const head = await headSha(buf.worktreePath);
    const moved = buf.headSha !== null && head !== buf.headSha;
    buf.headSha = head;

    const tree = await snapshotTree(buf);
    if (!tree) return;

    const pinned = buf.baseTree;
    if (pinned === null) {
      // The opening pass records what the worktree already held; without it the
      // first change to a file would carry everything it gained since HEAD.
      buf.baseTree = tree;
      return;
    }

    const at = Date.now();
    const command = commandRunningAt(buf, at);
    const attributed = command !== null || loadConfig().changeFeedAttributedOnly === false;
    if (moved || Date.now() < buf.quietUntil || !attributed) {
      // What git or another writer left is taken as the ground to measure from.
      buf.repin = false;
      buf.baseTree = tree;
      buf.fileBase.clear();
      return;
    }
    if (pinned === tree) {
      buf.repin = false;
      return;
    }

    const ignore = loadConfig().changeFeedIgnore ?? DEFAULT_IGNORE;
    const paths = (await changedPaths(buf, pinned, tree)).filter((p) => !isIgnored(p, ignore));
    if (paths.length === 0) return;

    // Each file is measured from where its own card started, which is only the
    // shared base for one that has no card open yet.
    const byBase = new Map<string, string[]>();
    for (const p of paths) {
      const base = buf.fileBase.get(p) ?? pinned;
      const group = byBase.get(base);
      if (group) group.push(p);
      else byBase.set(base, [p]);
    }

    const events: FeedEvent[] = [];
    let open: string | null = null;
    for (const [base, group] of byBase) {
      for (const d of await diffTrees(buf, base, tree, group)) {
        events.push({ kind: 'fs' as const, ts: at, id: `fs:${d.filePath}:${at}`, command: command ?? '', ...d });
        open = path.relative(buf.worktreePath, d.filePath);
        buf.fileBase.set(open, base);
      }
    }
    if (events.length === 0) return;

    // Narration ends every card; otherwise only the file reported last still has
    // one open, the rest having been closed by it. A closed card's file starts
    // again from where the worktree stands now.
    if (buf.repin) {
      buf.repin = false;
      buf.baseTree = tree;
      buf.fileBase.clear();
    } else {
      for (const p of buf.fileBase.keys()) if (p !== open) buf.fileBase.set(p, tree);
    }

    buf.events = prune([...buf.events, ...events]);
    const items = render(taskId, buf);
    writeJournal(
      taskId,
      [...buf.journalled, ...items.filter((i): i is FeedChange => i.kind === 'change' && !!i.command)].slice(
        -MAX_ITEMS,
      ),
    );
    feedWindow?.webContents.send(IPC_STREAM.CHANGE_FEED_ITEMS, taskId, items);

    await capScratch(buf);
  } catch {
    /* a worktree that cannot be scanned contributes nothing this round */
  } finally {
    buf.scanning = false;
  }
}

function prune(events: FeedEvent[]): FeedEvent[] {
  const kept = events.slice(-MAX_EVENTS);
  let budget = MAX_FS_EVENTS;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (kept[i].kind !== 'fs') continue;
    if (budget > 0) budget--;
    else kept.splice(i, 1);
  }
  return kept;
}

function render(taskId: string, buf: Buffered): FeedItem[] {
  buf.events.sort((a, b) => a.ts - b.ts);
  const live = foldFeed(buf.events, { taskId, worktreePath: buf.worktreePath });
  const seen = new Set(live.map((i) => i.id));
  const merged = [...buf.journalled.filter((c) => !seen.has(c.id)), ...live].sort((a, b) => a.timestamp - b.timestamp);
  return merged.slice(-MAX_ITEMS);
}

/** How an event is identified when the tail overlaps what the watcher already read. */
function eventKey(e: FeedEvent): string {
  return e.kind === 'text' ? `text:${e.uuid}` : `${e.kind}:${e.id}`;
}

/**
 * The task's feed, reading the transcript's tail the first time its panel opens.
 * What the agent said and the diffs it made through tool calls are all recorded
 * there; a change written through the shell before this point is not, because the
 * worktree cannot be read backwards.
 */
export function loadChangeFeed(taskId: string, worktreePath: string, sessionId?: string): FeedItem[] {
  const buf = buffers.get(taskId) ?? newBuffer(taskId, worktreePath, sessionId);
  buffers.set(taskId, buf);
  if (buf.backfilled) return render(taskId, buf);
  buf.backfilled = true;

  const file = transcriptFile(worktreePath, sessionId);
  if (file) {
    const lines = tail(file, BACKFILL_BYTES);
    const seen = new Set(buf.events.map(eventKey));
    const fresh = parseFeedLines(lines).filter((e) => !seen.has(eventKey(e)));
    collectSkillNames(lines, buf.skillNames);
    buf.events = [...buf.events, ...fresh];
  }
  // The agents this session forked wrote their changes to their own files.
  buf.events = prune([...buf.events, ...pullSubagents(buf)].sort((a, b) => a.ts - b.ts));
  buf.journalled = readJournal(taskId);
  return render(taskId, buf);
}

/**
 * Fold newly appended transcript lines, and whatever the subagents have written
 * since, into the task's feed. Null when nothing the feed shows has changed.
 */
export function appendChangeFeedLines(
  taskId: string,
  worktreePath: string,
  lines: string[],
  sessionId?: string,
): FeedItem[] | null {
  const buf = buffers.get(taskId) ?? newBuffer(taskId, worktreePath, sessionId);
  buffers.set(taskId, buf);

  collectSkillNames(lines, buf.skillNames);
  const parsed = parseFeedLines(lines);
  noteCommands(parsed, buf);
  const fresh = [...parsed, ...pullSubagents(buf)];
  if (fresh.length === 0) return null;

  buf.events = prune([...buf.events, ...fresh]);
  return render(taskId, buf);
}

/**
 * Advance a task's feed by one round: the transcript lines just read, whatever
 * the subagents appended, and — for the task being watched — the worktree.
 */
export function pollChangeFeed(
  taskId: string,
  worktreePath: string,
  lines: string[],
  sessionId: string | undefined,
  win: BrowserWindow,
): void {
  const items = appendChangeFeedLines(taskId, worktreePath, lines, sessionId);
  if (items) win.webContents.send(IPC_STREAM.CHANGE_FEED_ITEMS, taskId, items);

  const buf = buffers.get(taskId);
  if (buf && taskId === activeTaskId) void scanWorktree(taskId, buf);
}

function journalPath(taskId: string): string {
  return path.join(JOURNAL_ROOT, `${taskId}.jsonl`);
}

/** Keep the newest cards, matching what the feed itself will show. */
function writeJournal(taskId: string, cards: FeedChange[]): void {
  try {
    fs.mkdirSync(JOURNAL_ROOT, { recursive: true });
    fs.writeFileSync(journalPath(taskId), cards.map((c) => JSON.stringify(c)).join('\n'));
  } catch {
    /* a feed that cannot be journalled is still a feed */
  }
}

function readJournal(taskId: string): FeedChange[] {
  try {
    return fs
      .readFileSync(journalPath(taskId), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FeedChange);
  } catch {
    return [];
  }
}

/** The task is gone, and so is what it wrote. */
export function forgetChangeFeed(taskId: string): void {
  dropChangeFeed(taskId);
  fs.rmSync(journalPath(taskId), { force: true });
}

export function dropChangeFeed(taskId: string): void {
  const buf = buffers.get(taskId);
  if (buf) fs.rmSync(buf.scratch, { recursive: true, force: true });
  buffers.delete(taskId);
}
