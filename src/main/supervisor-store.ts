import type { SupervisorItem, SupervisorState } from '../shared/types';
import { getDb } from './db';

// biome-ignore lint/suspicious/noExplicitAny: row objects from DuckDB have dynamic fields
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
    createdAt: Number(row.created_at),
  };
  if (row.worktree_path != null) item.worktreePath = row.worktree_path;
  if (row.error_message != null) item.errorMessage = row.error_message;
  if (row.started_at != null) item.startedAt = Number(row.started_at);
  if (row.completed_at != null) item.completedAt = Number(row.completed_at);
  if (row.opened_as_task_id != null) item.openedAsTaskId = row.opened_as_task_id;
  return item;
}

const DEFAULT_STATE: SupervisorState = {
  running: false,
  concurrency: 2,
  items: [],
};

// In-memory cache, eagerly loaded
let cachedState: SupervisorState | null = null;

/** Pre-load supervisor state from DB. Call during startup. */
export async function initSupervisorStore(): Promise<void> {
  const db = getDb();

  // Load scalar state
  const stateReader = await db.runAndReadAll("SELECT * FROM supervisor_state WHERE key = 'state'");
  const stateRows = stateReader.getRowObjectsJS();

  let running = false;
  let concurrency = 2;
  if (stateRows.length > 0) {
    running = Boolean(stateRows[0].running ?? false);
    concurrency = Number(stateRows[0].concurrency ?? 2);
  }

  // Load items
  const itemsReader = await db.runAndReadAll('SELECT * FROM supervisor_items ORDER BY created_at');
  const items = itemsReader.getRowObjectsJS().map(rowToItem);

  cachedState = { running, concurrency, items };
}

export function loadSupervisorState(): SupervisorState {
  if (cachedState) return cachedState;
  // If not yet initialized, return default (shouldn't happen if initSupervisorStore is called on startup)
  return { ...DEFAULT_STATE, items: [] };
}

export function saveSupervisorState(state: SupervisorState): void {
  cachedState = state;
  // Fire-and-forget async persistence
  persistState(state).catch((err) => console.error('[supervisor-store] Failed to persist state:', err));
}

async function persistState(state: SupervisorState): Promise<void> {
  const db = getDb();

  // Upsert scalar state
  await db.run("INSERT OR REPLACE INTO supervisor_state (key, running, concurrency) VALUES ('state', ?, ?)", [
    state.running,
    state.concurrency,
  ]);

  // Replace all items
  await db.run('DELETE FROM supervisor_items');
  for (const item of state.items) {
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
}
