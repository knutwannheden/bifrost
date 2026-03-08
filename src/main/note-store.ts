import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Note } from '../shared/types';

const NOTES_DIR = path.join(os.homedir(), '.bifrost', 'notes');

// In-memory cache keyed by repoId, lazy-loaded from disk
const cache = new Map<string, Note[]>();

function notesPath(repoId: string): string {
  return path.join(NOTES_DIR, `${repoId}.json`);
}

function load(repoId: string): Note[] {
  const cached = cache.get(repoId);
  if (cached) return cached;
  const filePath = notesPath(repoId);
  if (!fs.existsSync(filePath)) {
    cache.set(repoId, []);
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const notes: Note[] = JSON.parse(raw);
    cache.set(repoId, notes);
    return notes;
  } catch {
    cache.set(repoId, []);
    return [];
  }
}

function save(repoId: string, notes: Note[]): void {
  if (!fs.existsSync(NOTES_DIR)) {
    fs.mkdirSync(NOTES_DIR, { recursive: true });
  }
  const filePath = notesPath(repoId);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
  cache.set(repoId, notes);
}

export function listNotes(repoId: string): Note[] {
  return load(repoId);
}

export function createNote(repoId: string, text: string): Note {
  const notes = load(repoId);
  const note: Note = {
    id: randomUUID(),
    text,
    createdAt: Date.now(),
    addressed: false,
  };
  notes.push(note);
  save(repoId, notes);
  return note;
}

export function updateNote(repoId: string, noteId: string, updates: { text?: string; addressed?: boolean }): Note {
  const notes = load(repoId);
  const idx = notes.findIndex((n) => n.id === noteId);
  if (idx === -1) throw new Error(`Note not found: ${noteId}`);
  notes[idx] = { ...notes[idx], ...updates };
  save(repoId, notes);
  return notes[idx];
}

export function deleteNote(repoId: string, noteId: string): void {
  const notes = load(repoId);
  const filtered = notes.filter((n) => n.id !== noteId);
  if (filtered.length !== notes.length) {
    save(repoId, filtered);
  }
}
