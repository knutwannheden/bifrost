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
  /** When the holder started on the resource, as against when it was offered one. */
  acceptedAt: number | null;
  releasedAt: number | null;
  /** The seizing claim that asked this holder to stop, if any. */
  yieldRequestedBy: number | null;
  /** The holder's session process, whose death releases the claim. */
  pid: number | null;
  /**
   * On a notice, how many claims may hold the resource while it stands. Zero
   * keeps the machine quiet and one makes work take turns. Null on every other
   * kind of claim, which constrains nobody but itself.
   */
  holderLimit: number | null;
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
  holderLimit?: number;
}

export interface BoardOptions {
  now?: () => number;
  /** Whether a process still exists, so a crashed holder's claim is dropped the next time the board is read. */
  alive?: (pid: number) => boolean;
  /** How long an offer is held open for the session at the front of the queue. */
  offerGraceMs?: number;
}

/** Long enough for a session polling in `wait` to pick its turn up, short enough that an idle one does not strand the resource. */
const OFFER_GRACE_MS = 60_000;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function fits(claim: Claim, holders: Claim[], limit = Number.POSITIVE_INFINITY): boolean {
  if (holders.length >= limit) return false;
  return claim.mode === 'shared' ? holders.every((h) => h.mode === 'shared') : holders.length === 0;
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
    accepted_at INTEGER,
    released_at INTEGER,
    yield_requested_by INTEGER,
    pid INTEGER,
    holder_limit INTEGER
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
  accepted_at: number | null;
  released_at: number | null;
  yield_requested_by: number | null;
  pid: number | null;
  holder_limit: number | null;
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
    acceptedAt: r.accepted_at,
    releasedAt: r.released_at,
    yieldRequestedBy: r.yield_requested_by,
    pid: r.pid,
    holderLimit: r.holder_limit,
  };
}

/** The claims store that decides which claims hold a resource now. */
export class Board {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly alive: (pid: number) => boolean;
  private readonly offerGraceMs: number;
  private depth = 0;

  private constructor(db: DatabaseSync, options: BoardOptions) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.alive = options.alive ?? processExists;
    this.offerGraceMs = options.offerGraceMs ?? OFFER_GRACE_MS;
    db.exec(SCHEMA);
    const columns = db.prepare('PRAGMA table_info(claims)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'pid')) db.exec('ALTER TABLE claims ADD COLUMN pid INTEGER');
    // A claim granted before the board tracked starts is treated as started, so
    // an upgrade does not take the resource off work already running.
    if (!columns.some((c) => c.name === 'holder_limit')) {
      db.exec('ALTER TABLE claims ADD COLUMN holder_limit INTEGER');
    }
    if (!columns.some((c) => c.name === 'accepted_at')) {
      db.exec('ALTER TABLE claims ADD COLUMN accepted_at INTEGER');
      db.exec('UPDATE claims SET accepted_at = granted_at WHERE granted_at IS NOT NULL');
    }
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
          `INSERT INTO claims (resource, mode, holder, session_id, pid, why, priority, ttl_ms, created_at, expires_at, holder_limit)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.holderLimit ?? null,
        );
      this.schedule(input.resource);
      return this.row(Number(lastInsertRowid));
    });
  }

  /**
   * Ties the claim's life to another process, for a wrapper holding it on the
   * session's behalf. A wrapper runs only on a resource its claim has, so this
   * is also how the claim starts on it.
   */
  attach(id: number, pid: number | null): void {
    this.transaction(() => {
      const { resource } = this.row(id);
      this.db.prepare('UPDATE claims SET pid = ? WHERE id = ?').run(pid, id);
      // An offer has to be on the table before it can be taken, and taking it
      // is what sends the offer it beat back to the queue.
      this.schedule(resource);
      if (pid !== null && this.start(id)) this.schedule(resource);
    });
  }

  /** Records that a granted claim has started on the resource, or false when it has nothing to start on. */
  private start(id: number): boolean {
    if (this.row(id).grantedAt === null) return false;
    this.db.prepare('UPDATE claims SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL').run(this.now(), id);
    return true;
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

  /** Extends the claim from now, and restates its reason when given one, which is how progress reaches waiters. */
  renew(id: number, ttlMs: number, why?: string): Claim {
    return this.transaction(() => {
      const claim = this.row(id);
      this.db
        .prepare('UPDATE claims SET ttl_ms = ?, expires_at = ?, why = ? WHERE id = ?')
        .run(ttlMs, this.now() + ttlMs, why ?? claim.why, id);
      // Renewing is a session saying it is still on this, which is all that
      // taking an offer takes when no wrapper is holding the claim.
      this.start(id);
      this.schedule(claim.resource);
      return this.row(id);
    });
  }

  /**
   * Releases the claim and files the same claim again right behind the claim
   * at the front of the queue, so a holder lets the next one run and takes its
   * turn straight after.
   */
  requeue(id: number): { next: Claim[]; claim: Claim } {
    return this.transaction(() => {
      const old = this.row(id);
      const front = this.status(old.resource).waiting[0];
      const next = this.release(id);
      const claim = this.claim({
        resource: old.resource,
        mode: old.mode,
        holder: old.holder,
        sessionId: old.sessionId ?? undefined,
        pid: old.pid ?? undefined,
        why: old.why,
        priority: front?.priority ?? old.priority,
        ttlMs: old.ttlMs,
        holderLimit: old.holderLimit ?? undefined,
      });
      if (!front) return { next, claim };
      // The queue sorts by priority, then age, then id, so sharing the front's
      // age and coming later by id puts this claim right behind it.
      this.db.prepare('UPDATE claims SET created_at = ? WHERE id = ?').run(front.createdAt, claim.id);
      this.schedule(old.resource);
      return { next, claim: this.row(claim.id) };
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
   * Lapsed claims and claims of dead sessions are released first. Then the
   * queue is walked by priority, then age, and each claim that fits beside the
   * current holders is granted until one does not fit, so a waiting exclusive
   * claim also holds back the shared claims behind it. A standing notice caps
   * how many may hold the resource at once, which is how the user makes the
   * machine quiet or makes work take turns.
   *
   * A grant is an offer until its holder starts on it. It is the front of the
   * queue's alone for the grace, and after that the next claim is offered the
   * resource too, so whichever session is ready to work gets it rather than
   * the one that happens to be asleep.
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

    const started = live.filter((c) => c.mode !== 'notice' && c.grantedAt !== null && c.acceptedAt !== null);
    const withdraw = this.db.prepare('UPDATE claims SET granted_at = NULL WHERE id = ?');
    for (const c of live) {
      if (c.mode === 'notice' || c.grantedAt === null || c.acceptedAt !== null) continue;
      if (fits(c, started)) continue;
      withdraw.run(c.id);
      c.grantedAt = null;
    }

    const holding = live.filter(
      (c) =>
        c.mode !== 'notice' &&
        c.grantedAt !== null &&
        (c.acceptedAt !== null || now - c.grantedAt <= this.offerGraceMs),
    );
    // The tightest standing notice decides how much may run, and with none the
    // resource is only bound by the modes the claims asked for.
    const limit = Math.min(...live.filter((c) => c.mode === 'notice').map((c) => c.holderLimit ?? 0));
    const grant = this.db.prepare('UPDATE claims SET granted_at = ?, expires_at = ? WHERE id = ?');
    for (const c of live) {
      if (c.mode === 'notice' || c.grantedAt !== null) continue;
      if (!fits(c, holding, limit)) break;
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
