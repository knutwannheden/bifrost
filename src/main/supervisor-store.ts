import type { SupervisorItem, SupervisorState } from '../shared/types';
import { getDb } from './db';

// biome-ignore lint/suspicious/noExplicitAny: row objects from SQLite have dynamic fields
type Row = Record<string, any>;

function rowToItem(row: Row): SupervisorItem {
  const item: SupervisorItem = {
    id: row.id,
    noteId: row.note_id,
    repoId: row.repo_id,
    noteText: row.note_text,
    status: row.status,
    name: row.name,
    branch: row.branch,
    createdAt: row.created_at,
  };
  if (row.worktree_path != null) item.worktreePath = row.worktree_path;
  if (row.error_message != null) item.errorMessage = row.error_message;
  if (row.started_at != null) item.startedAt = row.started_at;
  if (row.completed_at != null) item.completedAt = row.completed_at;
  if (row.opened_as_task_id != null) item.openedAsTaskId = row.opened_as_task_id;
  return item;
}

export function loadSupervisorState(): SupervisorState {
  const d = getDb();
  const stateRow = d.prepare("SELECT * FROM supervisor_state WHERE key = 'state'").get() as Row | undefined;
  const items = d.prepare<unknown[], Row>('SELECT * FROM supervisor_items ORDER BY created_at').all().map(rowToItem);

  return {
    running: stateRow ? !!stateRow.running : false,
    concurrency: stateRow ? stateRow.concurrency : 2,
    items,
  };
}

export function saveSupervisorState(state: SupervisorState): void {
  const d = getDb();
  const save = d.transaction(() => {
    d.prepare("INSERT OR REPLACE INTO supervisor_state (key, running, concurrency) VALUES ('state', ?, ?)").run(
      state.running ? 1 : 0,
      state.concurrency,
    );

    d.prepare('DELETE FROM supervisor_items').run();
    const stmt = d.prepare(
      `INSERT INTO supervisor_items (id, note_id, repo_id, note_text, status, name, branch,
        worktree_path, error_message, created_at, started_at, completed_at, opened_as_task_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of state.items) {
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
  });
  save();
}
