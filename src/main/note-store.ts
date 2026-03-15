import { randomUUID } from 'node:crypto';
import type { Note } from '../shared/types';
import { getDb } from './db';

// biome-ignore lint/suspicious/noExplicitAny: row objects from SQLite have dynamic fields
type Row = Record<string, any>;

function rowToNote(row: Row): Note {
  return {
    id: row.id,
    text: row.text,
    createdAt: row.created_at,
    addressed: !!row.addressed,
  };
}

export function listNotes(repoId: string): Note[] {
  return getDb().prepare('SELECT * FROM notes WHERE repo_id = ? ORDER BY created_at').all(repoId).map(rowToNote);
}

export function createNote(repoId: string, text: string): Note {
  const note: Note = {
    id: randomUUID(),
    text,
    createdAt: Date.now(),
    addressed: false,
  };
  getDb()
    .prepare('INSERT INTO notes (id, repo_id, text, created_at, addressed) VALUES (?, ?, ?, ?, ?)')
    .run(note.id, repoId, note.text, note.createdAt, 0);
  return note;
}

export function updateNote(repoId: string, noteId: string, updates: { text?: string; addressed?: boolean }): Note {
  const row = getDb().prepare('SELECT * FROM notes WHERE id = ? AND repo_id = ?').get(noteId, repoId);
  if (!row) throw new Error(`Note not found: ${noteId}`);
  const note = rowToNote(row);
  const updated = { ...note, ...updates };
  getDb()
    .prepare('UPDATE notes SET text = ?, addressed = ? WHERE id = ?')
    .run(updated.text, updated.addressed ? 1 : 0, noteId);
  return updated;
}

export function deleteNote(repoId: string, noteId: string): void {
  getDb().prepare('DELETE FROM notes WHERE id = ? AND repo_id = ?').run(noteId, repoId);
}
