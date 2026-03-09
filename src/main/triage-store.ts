import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TriageEntry } from '../shared/types';

const TRIAGE_FILE = path.join(os.homedir(), '.bifrost', 'triages.json');

let cache: TriageEntry[] | null = null;

function load(): TriageEntry[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(TRIAGE_FILE, 'utf-8');
    cache = JSON.parse(raw);
    return cache!;
  } catch {
    cache = [];
    return [];
  }
}

function save(entries: TriageEntry[]): void {
  const dir = path.dirname(TRIAGE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${TRIAGE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf-8');
  fs.renameSync(tmp, TRIAGE_FILE);
  cache = entries;
}

export function listTriages(): TriageEntry[] {
  return load();
}

export function addTriage(entry: TriageEntry): void {
  const entries = load();
  entries.push(entry);
  save(entries);
}

export function updateTriage(triageId: string, updates: Partial<TriageEntry>): void {
  const entries = load();
  const idx = entries.findIndex((e) => e.id === triageId);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...updates };
  save(entries);
}

export function deleteTriage(triageId: string): void {
  const entries = load();
  const filtered = entries.filter((e) => e.id !== triageId);
  if (filtered.length !== entries.length) {
    save(filtered);
  }
}
