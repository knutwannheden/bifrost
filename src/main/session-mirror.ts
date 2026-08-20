import { SerializeAddon } from '@xterm/addon-serialize';
// @xterm/headless names a "module" build that it does not ship, so every
// loader takes its CommonJS entry — which exposes only a default binding.
import headless from '@xterm/headless';

const { Terminal } = headless;

/**
 * A headless mirror of each session's screen, fed every PTY byte. On attach it
 * is resized to the connecting terminal and re-serialized, so the replay is
 * always shaped for the terminal receiving it — a raw byte replay carries no
 * geometry and lands mangled whenever the two differ.
 */
interface SessionMirror {
  term: InstanceType<typeof Terminal>;
  serializer: SerializeAddon;
  /** Output withheld from the renderer while a snapshot is being taken. */
  held: string[] | null;
  /** Settles a snapshot whose write callback can no longer arrive. */
  abandonSnapshot: (() => void) | null;
  /** A resize that arrived while a snapshot's flush was queued. */
  pendingResize: { cols: number; rows: number } | null;
}

export interface MirrorSnapshot {
  replay: string;
  held: string[];
}

const mirrors = new Map<string, SessionMirror>();
const SCROLLBACK = 1000;

export function createMirror(sessionId: string, cols: number, rows: number): void {
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  mirrors.set(sessionId, { term, serializer, held: null, abandonSnapshot: null, pendingResize: null });
}

export function disposeMirror(sessionId: string): void {
  const mirror = mirrors.get(sessionId);
  if (!mirror) return;
  // A disposed terminal drops pending write callbacks, so a snapshot waiting on
  // one is settled here.
  mirror.abandonSnapshot?.();
  mirror.pendingResize = null;
  mirror.term.dispose();
  mirrors.delete(sessionId);
}

/** The mirror's current width. Exposed for the invariant checks in scripts/. */
export function mirrorCols(sessionId: string): number | undefined {
  return mirrors.get(sessionId)?.term.cols;
}

export function resizeMirror(sessionId: string, cols: number, rows: number): void {
  const mirror = mirrors.get(sessionId);
  if (!mirror) return;
  // Resizing a terminal with a write queued strands that write's callback, and
  // a snapshot waits on one — so it lands once the snapshot has settled.
  if (mirror.held) mirror.pendingResize = { cols, rows };
  else mirror.term.resize(cols, rows);
}

/**
 * Feed session output to the mirror. Returns false while a snapshot is in
 * flight: that output is withheld and replayed with the snapshot instead.
 */
export function mirrorOutput(sessionId: string, data: string): boolean {
  const mirror = mirrors.get(sessionId);
  if (!mirror) return true;
  mirror.term.write(data);
  if (!mirror.held) return true;
  mirror.held.push(data);
  return false;
}

/**
 * The session's screen shaped for a terminal of this size, plus the output
 * withheld while it was taken. Null when the session has no mirror.
 */
export function snapshotMirror(sessionId: string, cols: number, rows: number): Promise<MirrorSnapshot | null> {
  const mirror = mirrors.get(sessionId);
  if (!mirror) return Promise.resolve(null);

  const held: string[] = mirror.held ?? [];
  mirror.held = held;

  // Resizing from inside the write callback corrupts the buffer, so the mirror
  // is reshaped first and the writes still queued land at the new width.
  mirror.term.resize(cols, rows);

  return new Promise((resolve) => {
    mirror.abandonSnapshot = () => {
      mirror.held = null;
      resolve(null);
    };
    // The mirror parses writes on its own schedule; this callback marks the
    // point it has caught up, so `held` is exactly what the snapshot lacks.
    mirror.term.write('', () => {
      mirror.abandonSnapshot = null;
      mirror.held = null;
      const replay = mirror.serializer.serialize();
      const deferred = mirror.pendingResize;
      mirror.pendingResize = null;
      // Applied outside the callback for the same reason.
      if (deferred) queueMicrotask(() => mirror.term.resize(deferred.cols, deferred.rows));
      resolve({ replay, held });
    });
  });
}
