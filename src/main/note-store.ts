import { randomUUID } from 'node:crypto';
import type { Note } from '../shared/types';
import { getDb } from './db';

// biome-ignore lint/suspicious/noExplicitAny: row objects from DuckDB have dynamic fields
type Row = Record<string, any>;

function rowToNote(row: Row): Note {
  return {
    id: row.id,
    text: row.text,
    createdAt: Number(row.created_at),
    addressed: row.addressed ?? false,
  };
}

// In-memory cache keyed by repoId, eagerly loaded from DB
const cache = new Map<string, Note[]>();

/** Pre-load all notes from DB into cache. Call during startup. */
export async function initNoteStore(): Promise<void> {
  const reader = await getDb().runAndReadAll('SELECT * FROM notes ORDER BY created_at');
  const rows = reader.getRowObjectsJS();
  cache.clear();
  for (const row of rows) {
    const repoId = row.repo_id as string;
    const note = rowToNote(row);
    const existing = cache.get(repoId);
    if (existing) {
      existing.push(note);
    } else {
      cache.set(repoId, [note]);
    }
  }
}

function persistNote(repoId: string, note: Note): void {
  getDb()
    .run('INSERT OR REPLACE INTO notes (id, repo_id, text, created_at, addressed) VALUES (?, ?, ?, ?, ?)', [
      note.id,
      repoId,
      note.text,
      note.createdAt,
      note.addressed,
    ])
    .catch((err) => console.error('[note-store] Failed to persist note:', err));
}

function removeNote(noteId: string): void {
  getDb()
    .run('DELETE FROM notes WHERE id = ?', [noteId])
    .catch((err) => console.error('[note-store] Failed to delete note:', err));
}

export function listNotes(repoId: string): Note[] {
  return cache.get(repoId) ?? [];
}

export function createNote(repoId: string, text: string): Note {
  const note: Note = {
    id: randomUUID(),
    text,
    createdAt: Date.now(),
    addressed: false,
  };
  const notes = cache.get(repoId) ?? [];
  notes.push(note);
  cache.set(repoId, notes);
  persistNote(repoId, note);
  return note;
}

export function updateNote(repoId: string, noteId: string, updates: { text?: string; addressed?: boolean }): Note {
  const notes = cache.get(repoId) ?? [];
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) throw new Error(`Note not found: ${noteId}`);
  notes[idx] = { ...notes[idx], ...updates };
  cache.set(repoId, notes);
  persistNote(repoId, notes[idx]);
  return notes[idx];
}

export function deleteNote(repoId: string, noteId: string): void {
  const notes = cache.get(repoId) ?? [];
  const filtered = notes.filter((n) => n.id !== noteId);
  if (filtered.length !== notes.length) {
    cache.set(repoId, filtered);
    removeNote(noteId);
  }
}
