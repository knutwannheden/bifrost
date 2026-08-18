import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from './config';
import { slugify } from './worktree-manager';

const BIFROST_DIR = path.join(os.homedir(), '.bifrost');
const DB_PATH = path.join(BIFROST_DIR, 'bifrost.db');

let db: Database.Database | null = null;

const CURRENT_VERSION = 3;

// SQLite schema — TEXT for strings, INTEGER for booleans/timestamps, JSON text for arrays
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_id       TEXT NOT NULL,
  base_branch   TEXT NOT NULL,
  branch        TEXT,
  worktree_path TEXT NOT NULL,
  session_id    TEXT,
  status        TEXT NOT NULL DEFAULT 'running',
  has_unread    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER,
  terminal_title TEXT,
  summary       TEXT,
  is_external   INTEGER DEFAULT 0,
  in_place      INTEGER DEFAULT 0,
  session_history TEXT,
  claude_active INTEGER DEFAULT 0,
  cur_outcome       TEXT,
  cur_confidence    TEXT,
  cur_reason        TEXT,
  cur_pr_state      TEXT,
  cur_branch_merged INTEGER,
  cur_classified_at INTEGER,
  cur_user_override TEXT,
  cur_user_note     TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);

CREATE TABLE IF NOT EXISTS triages (
  id                TEXT PRIMARY KEY,
  prompt            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  status            TEXT NOT NULL,
  completed_at      INTEGER,
  task_ids          TEXT,
  last_activity     TEXT,
  summary           TEXT,
  claude_session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_triages_status ON triages(status);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  addressed   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_repo ON notes(repo_id);

CREATE TABLE IF NOT EXISTS activity_entries (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  timestamp         INTEGER NOT NULL,
  type              TEXT NOT NULL,
  file_path         TEXT,
  commit_sha        TEXT,
  commit_message    TEXT,
  claude_event_kind TEXT,
  claude_text       TEXT,
  claude_tool_name  TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_task_ts ON activity_entries(task_id, timestamp);

CREATE TABLE IF NOT EXISTS supervisor_state (
  key         TEXT PRIMARY KEY,
  running     INTEGER NOT NULL DEFAULT 0,
  concurrency INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS supervisor_items (
  id              TEXT PRIMARY KEY,
  note_id         TEXT NOT NULL,
  repo_id         TEXT NOT NULL,
  note_text       TEXT NOT NULL,
  status          TEXT NOT NULL,
  name            TEXT NOT NULL,
  branch          TEXT NOT NULL,
  worktree_path   TEXT,
  error_message   TEXT,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  completed_at    INTEGER,
  opened_as_task_id TEXT
);

CREATE TABLE IF NOT EXISTS context_entries (
  id           INTEGER PRIMARY KEY,
  task_id      TEXT NOT NULL,
  task_name    TEXT NOT NULL,
  type         TEXT NOT NULL,
  content      TEXT NOT NULL,
  captured_at  INTEGER NOT NULL,
  has_selection INTEGER,
  jsonl_path   TEXT,
  line_number  INTEGER,
  uuid         TEXT,
  selected_text TEXT,
  selection_start INTEGER,
  selection_end   INTEGER,
  resolved_content TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_task ON context_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_context_captured ON context_entries(captured_at);

CREATE TABLE IF NOT EXISTS slack_seen_reactions (
  reaction_key TEXT PRIMARY KEY,
  seen_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

// Each row costs one blocking git subprocess call; this caps how long a large
// task table can hold up startup.
const BACKFILL_TIME_BUDGET_MS = 30_000;

/**
 * Recover each task's own branch, first from its worktree's HEAD and then,
 * for whatever is still unrecovered, by matching the task name against the
 * repo's local branches. Both passes share one time budget.
 */
function backfillTaskBranches(d: Database.Database): void {
  const deadline = Date.now() + BACKFILL_TIME_BUDGET_MS;
  const fromHead = backfillFromWorktreeHead(d, deadline);
  const fromName = backfillFromTaskName(d, deadline);
  console.log(
    `[db] Migration v3: recovered ${fromHead.recovered} of ${fromHead.total} task branches from worktree HEAD ` +
      `(processed ${fromHead.processed}), then ${fromName.recovered} of ${fromName.total} more from task name`,
  );
}

/**
 * Recover each task's own branch from its worktree. Confirms the directory is
 * the worktree's own root — `git symbolic-ref` resolves upward through nested
 * paths, so an unverified read could return an enclosing repo's branch. In-place
 * tasks share their worktree with the repo checkout, so their current branch
 * is not a fact about the task and is left alone.
 */
function backfillFromWorktreeHead(
  d: Database.Database,
  deadline: number,
): { recovered: number; processed: number; total: number } {
  const rows = d
    .prepare<unknown[], { id: string; worktree_path: string; in_place: number }>(
      'SELECT id, worktree_path, in_place FROM tasks WHERE worktree_path IS NOT NULL',
    )
    .all();
  const update = d.prepare('UPDATE tasks SET branch = ? WHERE id = ?');
  let recovered = 0;
  let processed = 0;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    processed++;
    if (row.in_place) continue;
    if (!fs.existsSync(row.worktree_path)) continue;
    try {
      // A pruned worktree or a detached HEAD is an ordinary outcome here, so
      // git's diagnostics on stderr would be startup noise for expected cases.
      const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: row.worktree_path,
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (fs.realpathSync(toplevel) !== fs.realpathSync(row.worktree_path)) continue;
      const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: row.worktree_path,
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (branch) {
        update.run(branch, row.id);
        recovered++;
      }
    } catch {
      // Not a git worktree root, no branch (detached HEAD), or the subprocess failed.
    }
  }
  return { recovered, processed, total: rows.length };
}

/**
 * Recover remaining branches by matching each task's name-derived slug
 * against the repo's local branches, which usually outlive the worktree.
 * Assigns only when exactly one task in the repo maps to that slug and a
 * branch with that name exists — a shared slug (`resolveAvailableBranchName`'s
 * `-2` suffixing) could belong to either task, so it is left NULL.
 */
function backfillFromTaskName(d: Database.Database, deadline: number): { recovered: number; total: number } {
  const rows = d
    .prepare<unknown[], { id: string; repo_id: string; name: string }>(
      'SELECT id, repo_id, name FROM tasks WHERE branch IS NULL',
    )
    .all();
  if (rows.length === 0) return { recovered: 0, total: 0 };

  const repoPaths = new Map(loadConfig().repos.map((r) => [r.id, r.path]));
  const rowsByRepo = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = rowsByRepo.get(row.repo_id);
    if (bucket) bucket.push(row);
    else rowsByRepo.set(row.repo_id, [row]);
  }

  // A candidate is blocked once its repo already has a task on that branch, from either
  // pass — branch names are scoped per repo, so the same name claimed in a different
  // repo is not a conflict.
  const claimedByRepo = new Map<string, Set<string>>();
  for (const r of d
    .prepare<unknown[], { repo_id: string; branch: string }>(
      'SELECT repo_id, branch FROM tasks WHERE branch IS NOT NULL',
    )
    .all()) {
    const bucket = claimedByRepo.get(r.repo_id);
    if (bucket) bucket.add(r.branch);
    else claimedByRepo.set(r.repo_id, new Set([r.branch]));
  }

  const update = d.prepare('UPDATE tasks SET branch = ? WHERE id = ?');
  let recovered = 0;
  for (const [repoId, repoRows] of rowsByRepo) {
    if (Date.now() >= deadline) break;
    const repoPath = repoPaths.get(repoId);
    if (!repoPath || !fs.existsSync(repoPath)) continue;
    const claimed = claimedByRepo.get(repoId) ?? new Set<string>();
    claimedByRepo.set(repoId, claimed);

    let branches: Set<string>;
    try {
      const out = execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], {
        cwd: repoPath,
        timeout: 10_000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      branches = new Set(
        out
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
    } catch {
      continue;
    }

    const slugCounts = new Map<string, number>();
    const rowBySlug = new Map<string, (typeof repoRows)[number]>();
    for (const row of repoRows) {
      const slug = slugify(row.name);
      slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
      rowBySlug.set(slug, row);
    }

    for (const [slug, count] of slugCounts) {
      if (count !== 1 || !branches.has(slug) || claimed.has(slug)) continue;
      const row = rowBySlug.get(slug);
      if (!row) continue;
      update.run(slug, row.id);
      claimed.add(slug);
      recovered++;
    }
  }
  return { recovered, total: rows.length };
}

export function openDatabase(): void {
  if (db) return;

  if (!fs.existsSync(BIFROST_DIR)) {
    fs.mkdirSync(BIFROST_DIR, { recursive: true });
  }

  try {
    db = new Database(DB_PATH);
  } catch (err) {
    console.error('[db] Failed to open database, attempting recovery:', err);
    const timestamp = Date.now();
    const corruptPath = `${DB_PATH}.corrupt.${timestamp}`;
    for (const ext of ['', '-wal', '-shm']) {
      const file = `${DB_PATH}${ext}`;
      if (fs.existsSync(file)) {
        fs.renameSync(file, `${corruptPath}${ext}`);
      }
    }
    db = new Database(DB_PATH);
  }

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  runMigrations();
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not open — call openDatabase() first');
  return db;
}

function runMigrations(): void {
  const d = getDb();

  d.exec(SCHEMA_SQL);

  const row = d.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;

  if (!row) {
    d.prepare('INSERT INTO schema_version VALUES (?)').run(CURRENT_VERSION);
    console.log(`[db] Initialized schema at version ${CURRENT_VERSION}`);
  } else if (row.version < CURRENT_VERSION) {
    if (row.version < 2) {
      d.exec('ALTER TABLE activity_entries DROP COLUMN diff');
      console.log('[db] Migration v2: dropped diff column from activity_entries');
    }
    if (row.version < 3) {
      // Atomic: an interrupted run rolls back cleanly, so schema_version always
      // matches whether base_branch/branch exist and a retry never trips a
      // duplicate-column error.
      d.transaction(() => {
        d.exec('ALTER TABLE tasks RENAME COLUMN branch TO base_branch');
        d.exec('ALTER TABLE tasks ADD COLUMN branch TEXT');
        d.prepare('UPDATE schema_version SET version = ?').run(3);
      })();
      // branch is optional and updates are idempotent, so running this partially
      // or more than once is harmless.
      backfillTaskBranches(d);
      console.log('[db] Migration v3: split tasks.branch into base_branch + branch');
    }
  }
}
