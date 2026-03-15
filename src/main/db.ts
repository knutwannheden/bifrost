import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBConnection, DuckDBInstance, listValue } from '@duckdb/node-api';

const BIFROST_DIR = path.join(os.homedir(), '.bifrost');
const DB_PATH = path.join(BIFROST_DIR, 'bifrost.duckdb');

let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;

const CURRENT_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id            VARCHAR PRIMARY KEY,
  name          VARCHAR NOT NULL,
  repo_id       VARCHAR NOT NULL,
  branch        VARCHAR NOT NULL,
  worktree_path VARCHAR NOT NULL,
  session_id    VARCHAR,
  status        VARCHAR NOT NULL DEFAULT 'running',
  has_unread    BOOLEAN NOT NULL DEFAULT false,
  created_at    BIGINT NOT NULL,
  archived_at   BIGINT,
  terminal_title VARCHAR,
  summary       VARCHAR,
  is_external   BOOLEAN DEFAULT false,
  in_place      BOOLEAN DEFAULT false,
  session_history VARCHAR[],
  claude_active BOOLEAN DEFAULT false,
  cur_outcome       VARCHAR,
  cur_confidence    VARCHAR,
  cur_reason        VARCHAR,
  cur_pr_state      VARCHAR,
  cur_branch_merged BOOLEAN,
  cur_classified_at BIGINT,
  cur_user_override VARCHAR,
  cur_user_note     VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_id);

CREATE TABLE IF NOT EXISTS triages (
  id                VARCHAR PRIMARY KEY,
  prompt            VARCHAR NOT NULL,
  created_at        BIGINT NOT NULL,
  status            VARCHAR NOT NULL,
  completed_at      BIGINT,
  task_ids          VARCHAR[],
  last_activity     VARCHAR,
  summary           VARCHAR,
  claude_session_id VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_triages_status ON triages(status);

CREATE TABLE IF NOT EXISTS notes (
  id          VARCHAR PRIMARY KEY,
  repo_id     VARCHAR NOT NULL,
  text        VARCHAR NOT NULL,
  created_at  BIGINT NOT NULL,
  addressed   BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_notes_repo ON notes(repo_id);

CREATE TABLE IF NOT EXISTS activity_entries (
  id                VARCHAR PRIMARY KEY,
  task_id           VARCHAR NOT NULL,
  timestamp         BIGINT NOT NULL,
  type              VARCHAR NOT NULL,
  file_path         VARCHAR,
  diff              VARCHAR,
  commit_sha        VARCHAR,
  commit_message    VARCHAR,
  claude_event_kind VARCHAR,
  claude_text       VARCHAR,
  claude_tool_name  VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_activity_task ON activity_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_task_ts ON activity_entries(task_id, timestamp);

CREATE TABLE IF NOT EXISTS supervisor_state (
  key         VARCHAR PRIMARY KEY,
  running     BOOLEAN NOT NULL DEFAULT false,
  concurrency INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS supervisor_items (
  id              VARCHAR PRIMARY KEY,
  note_id         VARCHAR NOT NULL,
  repo_id         VARCHAR NOT NULL,
  note_text       VARCHAR NOT NULL,
  status          VARCHAR NOT NULL,
  name            VARCHAR NOT NULL,
  branch          VARCHAR NOT NULL,
  worktree_path   VARCHAR,
  error_message   VARCHAR,
  created_at      BIGINT NOT NULL,
  started_at      BIGINT,
  completed_at    BIGINT,
  opened_as_task_id VARCHAR
);

CREATE TABLE IF NOT EXISTS context_entries (
  id           INTEGER PRIMARY KEY,
  task_id      VARCHAR NOT NULL,
  task_name    VARCHAR NOT NULL,
  type         VARCHAR NOT NULL,
  content      VARCHAR NOT NULL,
  captured_at  BIGINT NOT NULL,
  has_selection BOOLEAN,
  jsonl_path   VARCHAR,
  line_number  INTEGER,
  uuid         VARCHAR,
  selected_text VARCHAR,
  selection_start INTEGER,
  selection_end   INTEGER,
  resolved_content VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_context_task ON context_entries(task_id);
CREATE INDEX IF NOT EXISTS idx_context_captured ON context_entries(captured_at);

CREATE TABLE IF NOT EXISTS slack_seen_reactions (
  reaction_key VARCHAR PRIMARY KEY,
  seen_at      BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

export async function openDatabase(): Promise<void> {
  if (connection) return;

  if (!fs.existsSync(BIFROST_DIR)) {
    fs.mkdirSync(BIFROST_DIR, { recursive: true });
  }

  try {
    instance = await DuckDBInstance.create(DB_PATH);
    connection = await instance.connect();
  } catch (err) {
    console.error('[db] Failed to open database, attempting recovery:', err);
    // Rename corrupt file and start fresh
    const timestamp = Date.now();
    const corruptPath = `${DB_PATH}.corrupt.${timestamp}`;
    for (const ext of ['', '.wal']) {
      const file = `${DB_PATH}${ext}`;
      if (fs.existsSync(file)) {
        fs.renameSync(file, `${corruptPath}${ext}`);
      }
    }
    instance = await DuckDBInstance.create(DB_PATH);
    connection = await instance.connect();
  }

  await runMigrations();
}

export function closeDatabase(): void {
  if (connection) {
    connection.closeSync();
    connection = null;
  }
  if (instance) {
    instance.closeSync();
    instance = null;
  }
}

export function getDb(): DuckDBConnection {
  if (!connection) throw new Error('Database not open — call openDatabase() first');
  return connection;
}

async function runMigrations(): Promise<void> {
  const db = getDb();

  // Create schema (idempotent — all CREATE IF NOT EXISTS)
  await db.run(SCHEMA_SQL);

  // Check current version
  const versionReader = await db.runAndReadAll('SELECT version FROM schema_version');
  const versionRows = versionReader.getRowsJS();

  if (versionRows.length === 0) {
    // Fresh database — attempt import from JSON, then set version
    await importFromJson();
    await db.run('INSERT INTO schema_version VALUES (?)', [CURRENT_VERSION]);
    console.log(`[db] Initialized schema at version ${CURRENT_VERSION}`);
  } else {
    const currentVersion = versionRows[0][0] as number;
    if (currentVersion < CURRENT_VERSION) {
      // Run incremental migrations here in the future
      await db.run('UPDATE schema_version SET version = ?', [CURRENT_VERSION]);
    }
  }
}

async function importFromJson(): Promise<void> {
  const db = getDb();
  let totalImported = 0;

  // Import tasks
  const tasksFile = path.join(BIFROST_DIR, 'tasks.json');
  if (fs.existsSync(tasksFile)) {
    try {
      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
      for (const t of tasks) {
        await db.run(
          `INSERT INTO tasks (id, name, repo_id, branch, worktree_path, session_id, status, has_unread,
            created_at, archived_at, terminal_title, summary, is_external, in_place, session_history,
            claude_active, cur_outcome, cur_confidence, cur_reason, cur_pr_state, cur_branch_merged,
            cur_classified_at, cur_user_override, cur_user_note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            t.id,
            t.name,
            t.repoId,
            t.branch ?? '',
            t.worktreePath,
            t.sessionId ?? null,
            t.status,
            t.hasUnread ?? false,
            t.createdAt,
            t.archivedAt ?? null,
            t.terminalTitle ?? null,
            t.summary ?? null,
            t.isExternal ?? false,
            t.inPlace ?? false,
            t.sessionHistory ? listValue(t.sessionHistory) : null,
            t.claudeActive ?? false,
            t.curation?.outcome ?? null,
            t.curation?.confidence ?? null,
            t.curation?.reason ?? null,
            t.curation?.prState ?? null,
            t.curation?.branchMerged ?? null,
            t.curation?.classifiedAt ?? null,
            t.curation?.userOverride ?? null,
            t.curation?.userNote ?? null,
          ],
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
      for (const t of triages) {
        await db.run(
          `INSERT INTO triages (id, prompt, created_at, status, completed_at, task_ids, last_activity, summary, claude_session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            t.id,
            t.prompt,
            t.createdAt,
            t.status,
            t.completedAt ?? null,
            t.taskIds ? listValue(t.taskIds) : null,
            t.lastActivity ?? null,
            t.summary ?? null,
            t.claudeSessionId ?? null,
          ],
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
      let noteCount = 0;
      for (const file of files) {
        const repoId = file.replace('.json', '');
        const notes = JSON.parse(fs.readFileSync(path.join(notesDir, file), 'utf-8'));
        for (const n of notes) {
          await db.run('INSERT INTO notes (id, repo_id, text, created_at, addressed) VALUES (?, ?, ?, ?, ?)', [
            n.id,
            repoId,
            n.text,
            n.createdAt,
            n.addressed ?? false,
          ]);
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
      let activityCount = 0;
      for (const file of files) {
        const taskId = file.replace('.json', '');
        const entries = JSON.parse(fs.readFileSync(path.join(activityDir, file), 'utf-8'));
        for (const e of entries) {
          await db.run(
            `INSERT INTO activity_entries (id, task_id, timestamp, type, file_path, diff, commit_sha,
              commit_message, claude_event_kind, claude_text, claude_tool_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
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
            ],
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
      await db.run('INSERT INTO supervisor_state (key, running, concurrency) VALUES (?, ?, ?)', [
        'state',
        state.running ?? false,
        state.concurrency ?? 2,
      ]);
      for (const item of state.items ?? []) {
        await db.run(
          `INSERT INTO supervisor_items (id, note_id, repo_id, note_text, status, name, branch,
            worktree_path, error_message, created_at, started_at, completed_at, opened_as_task_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
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
          ],
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
      let contextCount = 0;
      for (const taskDir of taskDirs) {
        const filePath = path.join(tasksDir, taskDir, 'contexts.jsonl');
        if (!fs.existsSync(filePath)) continue;
        const data = fs.readFileSync(filePath, 'utf-8');
        for (const line of data.split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line);
            await db.run(
              `INSERT INTO context_entries (id, task_id, task_name, type, content, captured_at,
                has_selection, jsonl_path, line_number, uuid, selected_text, selection_start, selection_end, resolved_content)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                e.id,
                e.taskId,
                e.taskName,
                e.type,
                e.content,
                e.capturedAt,
                e.hasSelection ?? null,
                e.jsonlPath ?? null,
                e.lineNumber ?? null,
                e.uuid ?? null,
                e.selectedText ?? null,
                e.selectionStart ?? null,
                e.selectionEnd ?? null,
                e.resolvedContent ?? null,
              ],
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
      const now = Date.now();
      for (const key of reactions) {
        await db.run('INSERT INTO slack_seen_reactions (reaction_key, seen_at) VALUES (?, ?)', [key, now]);
      }
      console.log(`[db] Imported ${reactions.length} slack seen reactions`);
    } catch (err) {
      console.error('[db] Failed to import slack state:', err);
    }
  }

  if (totalImported > 0) {
    console.log(`[db] JSON import complete — ${totalImported} total records imported`);
  }
}
