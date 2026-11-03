import type { IPC_STREAM } from '../shared/ipc-channels.ts';

/** A task wants attention. Its one argument is the name to show. */
export const BELL = 'bell';

export type EventChannel = (typeof IPC_STREAM)[keyof typeof IPC_STREAM] | typeof BELL;

type Listener = (channel: EventChannel, args: unknown[]) => void;

const listeners: Listener[] = [];

/** One listener failing must not cost the others the event, nor the service that raised it. */
export function emit(channel: EventChannel, ...args: unknown[]): void {
  for (const listener of [...listeners]) {
    try {
      listener(channel, args);
    } catch (err) {
      console.error('[events] listener failed on', channel, err);
    }
  }
}

/** Returns the unsubscribe. */
export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const at = listeners.indexOf(listener);
    if (at >= 0) listeners.splice(at, 1);
  };
}
