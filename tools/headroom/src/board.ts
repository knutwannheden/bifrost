import { DatabaseSync } from 'node:sqlite';

export type Mode = 'notice' | 'shared' | 'exclusive';

/** One request for a resource, with its mode, holder, reason, priority and lifetime. */
export interface Claim {
  id: number;
  resource: string;
  mode: Mode;
  /** The name other sessions address the holder by. */
  holder: string;
  sessionId: string | null;
  /** What the holder is doing, and what breaks if someone proceeds anyway. */
  why: string;
  priority: number;
  ttlMs: number;
  createdAt: number;
  /** When the claim lapses unless renewed, counted from the grant once there is one. */
  expiresAt: number;
  grantedAt: number | null;
  releasedAt: number | null;
  /** The seizing claim that asked this holder to stop, if any. */
  yieldRequestedBy: number | null;
  /** The holder's session process, whose death releases the claim. */
  pid: number | null;
}

export interface ClaimInput {
  resource: string;
  mode: Mode;
  holder: string;
  sessionId?: string;
  pid?: number;
  why: string;
  priority?: number;
  ttlMs: number;
}

export interface BoardOptions {
  now?: () => number;
  /** Whether a process still exists, so a crashed holder's claim is dropped the next time the board is read. */
  alive?: (pid: number) => boolean;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Status {
  holding: Claim[];
  waiting: Claim[];
  notices: Claim[];
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource TEXT NOT NULL,
    mode TEXT NOT NULL,
    holder TEXT NOT NULL,
    session_id TEXT,
    why TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    ttl_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    granted_at INTEGER,
    released_at INTEGER,
    yield_requested_by INTEGER,
    pid INTEGER
  );
  CREATE INDEX IF NOT EXISTS claims_live ON claims(resource) WHERE released_at IS NULL;
`;

interface Row {
  id: number;
  resource: string;
  mode: Mode;
  holder: string;
  session_id: string | null;
  why: string;
  priority: number;
  ttl_ms: number;
  created_at: number;
  expires_at: number;
  granted_at: number | null;
  released_at: number | null;
  yield_requested_by: number | null;
  pid: number | null;
}

function toClaim(r: Row): Claim {
  return {
    id: r.id,
    resource: r.resource,
    mode: r.mode,
    holder: r.holder,
    sessionId: r.session_id,
    why: r.why,
    priority: r.priority,
    ttlMs: r.ttl_ms,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    grantedAt: r.granted_at,
    releasedAt: r.released_at,
    yieldRequestedBy: r.yield_requested_by,
    pid: r.pid,
  };
}

/** The claims store that decides which claims hold a resource now. */
export class Board {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private depth = 0;

  private constructor(db: DatabaseSync, options: BoardOptions) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.alive = options.alive ?? processExists;
    db.exec(SCHEMA);
    const columns = db.prepare('PRAGMA table_info(claims)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'pid')) db.exec('ALTER TABLE claims ADD COLUMN pid INTEGER');
  }

  static open(file: string, options: BoardOptions = {}): Board {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    return new Board(db, options);
  }

  static inMemory(options: BoardOptions = {}): Board {
    return new Board(new DatabaseSync(':memory:'), options);
  }

  close(): void {
    this.db.close();
  }

  claim(input: ClaimInput): Claim {
    return this.transaction(() => {
      const now = this.now();
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO claims (resource, mode, holder, session_id, pid, why, priority, ttl_ms, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.resource,
          input.mode,
          input.holder,
          input.sessionId ?? null,
          input.pid ?? null,
          input.why,
          input.priority ?? 0,
          input.ttlMs,
          now,
          now + input.ttlMs,
        );
      this.schedule(input.resource);
      return this.row(Number(lastInsertRowid));
    });
  }

  /** Releases the claim and returns the claims granted because it went. */
  release(id: number): Claim[] {
    return this.transaction(() => {
      const claim = this.row(id);
      const before = new Set(
        this.schedule(claim.resource)
          .filter((c) => c.grantedAt !== null)
          .map((c) => c.id),
      );
      this.db.prepare('UPDATE claims SET released_at = ? WHERE id = ? AND released_at IS NULL').run(this.now(), id);
      return this.schedule(claim.resource).filter((c) => c.grantedAt !== null && !before.has(c.id));
    });
  }

  renew(id: number, ttlMs: number): Claim {
    return this.transaction(() => {
      const claim = this.row(id);
      this.db.prepare('UPDATE claims SET ttl_ms = ?, expires_at = ? WHERE id = ?').run(ttlMs, this.now() + ttlMs, id);
      this.schedule(claim.resource);
      return this.row(id);
    });
  }

  /**
   * An exclusive claim placed ahead of everything queued, with every current
   * holder asked to stop for it.
   */
  seize(input: Omit<ClaimInput, 'mode' | 'priority'>): { claim: Claim; yielding: Claim[] } {
    return this.transaction(() => {
      const { holding, waiting } = this.status(input.resource);
      const top = Math.max(0, ...holding.map((c) => c.priority), ...waiting.map((c) => c.priority));
      const claim = this.claim({ ...input, mode: 'exclusive', priority: top + 1 });
      if (claim.grantedAt !== null) return { claim, yielding: [] };
      const ask = this.db.prepare('UPDATE claims SET yield_requested_by = ? WHERE id = ?');
      for (const h of holding) ask.run(claim.id, h.id);
      return { claim, yielding: holding };
    });
  }

  get(id: number): Claim | undefined {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as Row | undefined;
      if (!row) return undefined;
      this.schedule(row.resource);
      return this.row(id);
    });
  }

  status(resource?: string): Status {
    return this.transaction(() => {
      const resources = resource
        ? [resource]
        : (
            this.db.prepare('SELECT DISTINCT resource FROM claims WHERE released_at IS NULL').all() as {
              resource: string;
            }[]
          ).map((r) => r.resource);
      const status: Status = { holding: [], waiting: [], notices: [] };
      for (const r of resources) {
        for (const c of this.schedule(r)) {
          if (c.mode === 'notice') status.notices.push(c);
          else if (c.grantedAt !== null) status.holding.push(c);
          else status.waiting.push(c);
        }
      }
      return status;
    });
  }

  /**
   * Settles who holds the resource and returns its live claims in queue order.
   * Lapsed claims and claims of dead sessions are released first. A notice
   * stops every grant. Otherwise the
   * queue is walked by priority, then age, and each claim that fits beside the
   * current holders is granted until one does not fit, so a waiting exclusive
   * claim also holds back the shared claims behind it.
   */
  private schedule(resource: string): Claim[] {
    const now = this.now();
    this.db
      .prepare('UPDATE claims SET released_at = ? WHERE resource = ? AND released_at IS NULL AND expires_at <= ?')
      .run(now, resource, now);
    const pids = this.db
      .prepare('SELECT id, pid FROM claims WHERE resource = ? AND released_at IS NULL AND pid IS NOT NULL')
      .all(resource) as unknown as { id: number; pid: number }[];
    const drop = this.db.prepare('UPDATE claims SET released_at = ? WHERE id = ?');
    for (const { id, pid } of pids) if (!this.alive(pid)) drop.run(now, id);
    const live = (
      this.db
        .prepare(
          'SELECT * FROM claims WHERE resource = ? AND released_at IS NULL ORDER BY priority DESC, created_at ASC, id ASC',
        )
        .all(resource) as unknown as Row[]
    ).map(toClaim);

    const holding = live.filter((c) => c.mode !== 'notice' && c.grantedAt !== null);
    const blocked = live.some((c) => c.mode === 'notice');
    const grant = this.db.prepare('UPDATE claims SET granted_at = ?, expires_at = ? WHERE id = ?');
    for (const c of live) {
      if (c.mode === 'notice' || c.grantedAt !== null) continue;
      if (blocked) break;
      const fits = c.mode === 'shared' ? holding.every((h) => h.mode === 'shared') : holding.length === 0;
      if (!fits) break;
      grant.run(now, now + c.ttlMs, c.id);
      c.grantedAt = now;
      c.expiresAt = now + c.ttlMs;
      holding.push(c);
    }
    return live;
  }

  private row(id: number): Claim {
    const row = this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new Error(`No claim ${id}`);
    return toClaim(row);
  }

  // Several CLI processes share the file, so each operation settles the queue
  // under one write lock. An operation built from others joins theirs.
  private transaction<T>(body: () => T): T {
    if (this.depth > 0) return body();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
    }
  }
}
