import { type DuckDBValue, listValue } from '@duckdb/node-api';
import type { TriageEntry } from '../shared/types';
import { getDb } from './db';

// biome-ignore lint/suspicious/noExplicitAny: row objects from DuckDB have dynamic fields
type Row = Record<string, any>;

function rowToTriage(row: Row): TriageEntry {
  const entry: TriageEntry = {
    id: row.id,
    prompt: row.prompt,
    createdAt: Number(row.created_at),
    status: row.status,
  };
  if (row.completed_at != null) entry.completedAt = Number(row.completed_at);
  if (row.task_ids != null) entry.taskIds = row.task_ids;
  if (row.last_activity != null) entry.lastActivity = row.last_activity;
  if (row.summary != null) entry.summary = row.summary;
  if (row.claude_session_id != null) entry.claudeSessionId = row.claude_session_id;
  return entry;
}

function triageValues(t: TriageEntry): DuckDBValue[] {
  return [
    t.id,
    t.prompt,
    t.createdAt,
    t.status,
    t.completedAt ?? null,
    t.taskIds ? listValue(t.taskIds) : null,
    t.lastActivity ?? null,
    t.summary ?? null,
    t.claudeSessionId ?? null,
  ];
}

const UPSERT_SQL = `INSERT OR REPLACE INTO triages (
  id, prompt, created_at, status, completed_at, task_ids, last_activity, summary, claude_session_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// In-memory cache for synchronous access — loaded lazily from DB
let cache: TriageEntry[] | null = null;

function loadSync(): TriageEntry[] {
  if (cache) return cache;
  // Can't await here — return empty on first call, background-load fills cache
  cache = [];
  getDb()
    .runAndReadAll('SELECT * FROM triages ORDER BY created_at DESC')
    .then((reader) => {
      cache = reader.getRowObjectsJS().map(rowToTriage);
    })
    .catch((err) => console.error('[triage-store] Failed to load triages:', err));
  return cache;
}

function persistAll(): void {
  if (!cache) return;
  const entries = cache;
  (async () => {
    const db = getDb();
    await db.run('DELETE FROM triages');
    for (const t of entries) {
      await db.run(UPSERT_SQL, triageValues(t));
    }
  })().catch((err) => console.error('[triage-store] Failed to persist triages:', err));
}

/** Pre-load triages from DB into cache. Call during startup. */
export async function initTriageStore(): Promise<void> {
  const reader = await getDb().runAndReadAll('SELECT * FROM triages ORDER BY created_at DESC');
  cache = reader.getRowObjectsJS().map(rowToTriage);
}

export function listTriages(): TriageEntry[] {
  return loadSync();
}

export function addTriage(entry: TriageEntry): void {
  const entries = loadSync();
  entries.push(entry);
  persistAll();
}

export function updateTriage(triageId: string, updates: Partial<TriageEntry>): void {
  const entries = loadSync();
  const idx = entries.findIndex((e) => e.id === triageId);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...updates };
  persistAll();
}

export function deleteTriage(triageId: string): void {
  const entries = loadSync();
  const filtered = entries.filter((e) => e.id !== triageId);
  if (filtered.length !== entries.length) {
    cache = filtered;
    persistAll();
  }
}
