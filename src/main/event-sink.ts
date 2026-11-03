import type { IPC_STREAM } from '../shared/ipc-channels.ts';

/** A task wants attention. Its one argument is the name to show. */
export const BELL = 'bell';

export type EventChannel = (typeof IPC_STREAM)[keyof typeof IPC_STREAM] | typeof BELL;

/** origin names the instance an event came from, and is absent for this one's own. */
type Listener = (channel: EventChannel, args: unknown[], origin?: string) => void;

const listeners: Listener[] = [];

export function emit(channel: EventChannel, ...args: unknown[]): void {
  deliver(channel, args);
}

/** Raises again an event that the instance named origin raised. */
export function emitFrom(origin: string, channel: EventChannel, ...args: unknown[]): void {
  deliver(channel, args, origin);
}

/** One listener failing must not cost the others the event, nor the service that raised it. */
function deliver(channel: EventChannel, args: unknown[], origin?: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(channel, args, origin);
    } catch (err) {
      console.error('[events] listener failed on', channel, err);
    }
  }
}

/** Whether anyone listens: a window, or another instance subscribed to this one. */
export function listening(): boolean {
  return listeners.length > 0;
}

/** Returns the unsubscribe. */
export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}
