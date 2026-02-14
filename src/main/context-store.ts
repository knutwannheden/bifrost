export interface ContextEntry {
  id: number;
  content: string;
  label: string;
  taskId?: string;
  createdAt: number;
}

const MAX_ENTRIES = 200;
const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CONTENT_SIZE = 100 * 1024; // 100KB

let nextId = 1;
const entries = new Map<number, ContextEntry>();

export function store(content: string, label: string, taskId?: string): number {
  cleanup();

  const truncated = content.length > MAX_CONTENT_SIZE
    ? content.slice(0, MAX_CONTENT_SIZE) + '\n... (truncated)'
    : content;

  const id = nextId++;
  entries.set(id, {
    id,
    content: truncated,
    label,
    taskId,
    createdAt: Date.now(),
  });

  // Evict oldest if over limit
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }

  return id;
}

export function resolve(id: number): ContextEntry | null {
  cleanup();
  return entries.get(id) ?? null;
}

function cleanup(): void {
  const now = Date.now();
  for (const [id, entry] of entries) {
    if (now - entry.createdAt > TTL_MS) {
      entries.delete(id);
    }
  }
}
