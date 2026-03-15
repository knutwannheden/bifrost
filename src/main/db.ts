import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const BIFROST_DIR = path.join(os.homedir(), '.bifrost');
const DB_PATH = path.join(BIFROST_DIR, 'bifrost.db');

let db: Database.Database | null = null;

const CURRENT_VERSION = 1;

// SQLite schema — TEXT for strings, INTEGER for booleans/timestamps, JSON text for arrays
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  repo_id       TEXT NOT NULL,
  branch        TEXT NOT NULL,
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
  diff              TEXT,
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
    importFromJson();
    d.prepare('INSERT INTO schema_version VALUES (?)').run(CURRENT_VERSION);
    console.log(`[db] Initialized schema at version ${CURRENT_VERSION}`);
  } else if (row.version < CURRENT_VERSION) {
    // Future incremental migrations go here
    d.prepare('UPDATE schema_version SET version = ?').run(CURRENT_VERSION);
  }
}

function importFromJson(): void {
  const d = getDb();
  let totalImported = 0;

  // Wrap all imports in a transaction for speed
  const runImport = d.transaction(() => {
    // Import tasks
    const tasksFile = path.join(BIFROST_DIR, 'tasks.json');
    if (fs.existsSync(tasksFile)) {
      try {
        const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
        const stmt = d.prepare(
          `INSERT INTO tasks (id, name, repo_id, branch, worktree_path, session_id, status, has_unread,
            created_at, archived_at, terminal_title, summary, is_external, in_place, session_history,
            claude_active, cur_outcome, cur_confidence, cur_reason, cur_pr_state, cur_branch_merged,
            cur_classified_at, cur_user_override, cur_user_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const t of tasks) {
          stmt.run(
            t.id,
            t.name,
            t.repoId,
            t.branch ?? '',
            t.worktreePath,
            t.sessionId ?? null,
            t.status,
            t.hasUnread ? 1 : 0,
            t.createdAt,
            t.archivedAt ?? null,
            t.terminalTitle ?? null,
            t.summary ?? null,
            t.isExternal ? 1 : 0,
            t.inPlace ? 1 : 0,
            t.sessionHistory ? JSON.stringify(t.sessionHistory) : null,
            t.claudeActive ? 1 : 0,
            t.curation?.outcome ?? null,
            t.curation?.confidence ?? null,
            t.curation?.reason ?? null,
            t.curation?.prState ?? null,
            t.curation?.branchMerged != null ? (t.curation.branchMerged ? 1 : 0) : null,
            t.curation?.classifiedAt ?? null,
            t.curation?.userOverride ?? null,
            t.curation?.userNote ?? null,
          );
        }
        totalImported += tasks.length;
        console.log(`[db] Imported ${tasks.length} tasks from JSON`);
      } catch (err) {
        console.error('[db] Failed to import tasks:', err);
      }
    }

    // Import triages
    const triagesFile = path.join(BIFROST_DIR, 'triages.json');
    if (fs.existsSync(triagesFile)) {
      try {
        const triages = JSON.parse(fs.readFileSync(triagesFile, 'utf-8'));
        const stmt = d.prepare(
          `INSERT INTO triages (id, prompt, created_at, status, completed_at, task_ids, last_activity, summary, claude_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const t of triages) {
          stmt.run(
            t.id,
            t.prompt,
            t.createdAt,
            t.status,
            t.completedAt ?? null,
            t.taskIds ? JSON.stringify(t.taskIds) : null,
            t.lastActivity ?? null,
            t.summary ?? null,
            t.claudeSessionId ?? null,
          );
        }
        totalImported += triages.length;
        console.log(`[db] Imported ${triages.length} triages from JSON`);
      } catch (err) {
        console.error('[db] Failed to import triages:', err);
      }
    }

    // Import notes (per-repo files)
    const notesDir = path.join(BIFROST_DIR, 'notes');
    if (fs.existsSync(notesDir)) {
      try {
        const files = fs.readdirSync(notesDir).filter((f) => f.endsWith('.json'));
        const stmt = d.prepare('INSERT INTO notes (id, repo_id, text, created_at, addressed) VALUES (?, ?, ?, ?, ?)');
        let noteCount = 0;
        for (const file of files) {
          const repoId = file.replace('.json', '');
          const notes = JSON.parse(fs.readFileSync(path.join(notesDir, file), 'utf-8'));
          for (const n of notes) {
            stmt.run(n.id, repoId, n.text, n.createdAt, n.addressed ? 1 : 0);
            noteCount++;
          }
        }
        totalImported += noteCount;
        console.log(`[db] Imported ${noteCount} notes from JSON`);
      } catch (err) {
        console.error('[db] Failed to import notes:', err);
      }
    }

    // Import activity entries (per-task files)
    const activityDir = path.join(BIFROST_DIR, 'activity');
    if (fs.existsSync(activityDir)) {
      try {
        const files = fs.readdirSync(activityDir).filter((f) => f.endsWith('.json'));
        const stmt = d.prepare(
          `INSERT INTO activity_entries (id, task_id, timestamp, type, file_path, diff, commit_sha,
            commit_message, claude_event_kind, claude_text, claude_tool_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        let activityCount = 0;
        for (const file of files) {
          const taskId = file.replace('.json', '');
          const entries = JSON.parse(fs.readFileSync(path.join(activityDir, file), 'utf-8'));
          for (const e of entries) {
            stmt.run(
              e.id,
              taskId,
              e.timestamp,
              e.type,
              e.filePath ?? null,
              e.diff ?? null,
              e.commitSha ?? null,
              e.commitMessage ?? null,
              e.claudeEventKind ?? null,
              e.claudeText ?? null,
              e.claudeToolName ?? null,
            );
            activityCount++;
          }
        }
        totalImported += activityCount;
        console.log(`[db] Imported ${activityCount} activity entries from JSON`);
      } catch (err) {
        console.error('[db] Failed to import activity entries:', err);
      }
    }

    // Import supervisor state
    const supervisorFile = path.join(BIFROST_DIR, 'supervisor.json');
    if (fs.existsSync(supervisorFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(supervisorFile, 'utf-8'));
        d.prepare('INSERT INTO supervisor_state (key, running, concurrency) VALUES (?, ?, ?)').run(
          'state',
          state.running ? 1 : 0,
          state.concurrency ?? 2,
        );
        const stmt = d.prepare(
          `INSERT INTO supervisor_items (id, note_id, repo_id, note_text, status, name, branch,
            worktree_path, error_message, created_at, started_at, completed_at, opened_as_task_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const item of state.items ?? []) {
          stmt.run(
            item.id,
            item.noteId,
            item.repoId,
            item.noteText,
            item.status,
            item.name,
            item.branch,
            item.worktreePath ?? null,
            item.errorMessage ?? null,
            item.createdAt,
            item.startedAt ?? null,
            item.completedAt ?? null,
            item.openedAsTaskId ?? null,
          );
        }
        console.log(`[db] Imported supervisor state (${(state.items ?? []).length} items)`);
      } catch (err) {
        console.error('[db] Failed to import supervisor state:', err);
      }
    }

    // Import context entries (per-task JSONL files)
    const tasksDir = path.join(BIFROST_DIR, 'tasks');
    if (fs.existsSync(tasksDir)) {
      try {
        const taskDirs = fs.readdirSync(tasksDir);
        const stmt = d.prepare(
          `INSERT INTO context_entries (id, task_id, task_name, type, content, captured_at,
            has_selection, jsonl_path, line_number, uuid, selected_text, selection_start, selection_end, resolved_content)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        let contextCount = 0;
        for (const taskDir of taskDirs) {
          const filePath = path.join(tasksDir, taskDir, 'contexts.jsonl');
          if (!fs.existsSync(filePath)) continue;
          const data = fs.readFileSync(filePath, 'utf-8');
          for (const line of data.split('\n')) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              stmt.run(
                e.id,
                e.taskId,
                e.taskName,
                e.type,
                e.content,
                e.capturedAt,
                e.hasSelection != null ? (e.hasSelection ? 1 : 0) : null,
                e.jsonlPath ?? null,
                e.lineNumber ?? null,
                e.uuid ?? null,
                e.selectedText ?? null,
                e.selectionStart ?? null,
                e.selectionEnd ?? null,
                e.resolvedContent ?? null,
              );
              contextCount++;
            } catch {
              // Skip malformed lines
            }
          }
        }
        totalImported += contextCount;
        console.log(`[db] Imported ${contextCount} context entries from JSONL`);
      } catch (err) {
        console.error('[db] Failed to import context entries:', err);
      }
    }

    // Import slack seen reactions
    const slackFile = path.join(BIFROST_DIR, 'slack.json');
    if (fs.existsSync(slackFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(slackFile, 'utf-8'));
        const reactions: string[] = Array.isArray(state.seenReactions) ? state.seenReactions : [];
        const stmt = d.prepare('INSERT INTO slack_seen_reactions (reaction_key, seen_at) VALUES (?, ?)');
        const now = Date.now();
        for (const key of reactions) {
          stmt.run(key, now);
        }
        console.log(`[db] Imported ${reactions.length} slack seen reactions`);
      } catch (err) {
        console.error('[db] Failed to import slack state:', err);
      }
    }
  });

  runImport();

  if (totalImported > 0) {
    console.log(`[db] JSON import complete — ${totalImported} total records imported`);
  }
}
