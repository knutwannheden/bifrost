import type { TriageEntry } from '../shared/types';
import { getDb } from './db';

// biome-ignore lint/suspicious/noExplicitAny: row objects from SQLite have dynamic fields
type Row = Record<string, any>;

function rowToTriage(row: Row): TriageEntry {
  const entry: TriageEntry = {
    id: row.id,
    prompt: row.prompt,
    createdAt: row.created_at,
    status: row.status,
  };
  if (row.completed_at != null) entry.completedAt = row.completed_at;
  if (row.task_ids != null) entry.taskIds = JSON.parse(row.task_ids);
  if (row.last_activity != null) entry.lastActivity = row.last_activity;
  if (row.summary != null) entry.summary = row.summary;
  if (row.claude_session_id != null) entry.claudeSessionId = row.claude_session_id;
  return entry;
}

const UPSERT_SQL = `INSERT OR REPLACE INTO triages (
  id, prompt, created_at, status, completed_at, task_ids, last_activity, summary, claude_session_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function triageParams(t: TriageEntry) {
  return [
    t.id,
    t.prompt,
    t.createdAt,
    t.status,
    t.completedAt ?? null,
    t.taskIds ? JSON.stringify(t.taskIds) : null,
    t.lastActivity ?? null,
    t.summary ?? null,
    t.claudeSessionId ?? null,
  ];
}

export function listTriages(): TriageEntry[] {
  return getDb().prepare('SELECT * FROM triages ORDER BY created_at DESC').all().map(rowToTriage);
}

export function addTriage(entry: TriageEntry): void {
  getDb()
    .prepare(UPSERT_SQL)
    .run(...triageParams(entry));
}

export function updateTriage(triageId: string, updates: Partial<TriageEntry>): void {
  const entries = listTriages();
  const idx = entries.findIndex((e) => e.id === triageId);
  if (idx === -1) return;
  const updated = { ...entries[idx], ...updates };
  getDb()
    .prepare(UPSERT_SQL)
    .run(...triageParams(updated));
}

export function deleteTriage(triageId: string): void {
  getDb().prepare('DELETE FROM triages WHERE id = ?').run(triageId);
}
