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
}

const mirrors = new Map<string, SessionMirror>();
const SCROLLBACK = 1000;

export function createMirror(sessionId: string, cols: number, rows: number): void {
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  mirrors.set(sessionId, { term, serializer, held: null });
}

export function disposeMirror(sessionId: string): void {
  mirrors.get(sessionId)?.term.dispose();
  mirrors.delete(sessionId);
}

export function resizeMirror(sessionId: string, cols: number, rows: number): void {
  mirrors.get(sessionId)?.term.resize(cols, rows);
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
export function snapshotMirror(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<{ replay: string; held: string[] } | null> {
  const mirror = mirrors.get(sessionId);
  if (!mirror) return Promise.resolve(null);

  const held: string[] = mirror.held ?? [];
  mirror.held = held;

  // Resizing from inside the write callback corrupts the buffer, so the mirror
  // is reshaped first and the writes still queued land at the new width.
  mirror.term.resize(cols, rows);

  return new Promise((resolve) => {
    // The mirror parses writes on its own schedule; this callback marks the
    // point it has caught up, so `held` is exactly what the snapshot lacks.
    mirror.term.write('', () => {
      const replay = mirror.serializer.serialize();
      mirror.held = null;
      resolve({ replay, held });
    });
  });
}
