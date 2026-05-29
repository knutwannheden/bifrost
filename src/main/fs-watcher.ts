import { type AsyncSubscription, subscribe } from '@parcel/watcher';

/**
 * Thin, debounced wrapper around `@parcel/watcher`.
 *
 * Bifrost's watchers don't care *what* changed — only that *something* did, so
 * they can re-run their existing (idempotent) git/JSONL logic. So this wrapper
 * deliberately discards the event payload and exposes a single coalesced
 * "something changed" signal. Callers keep a slow safety-net poll to cover any
 * events the OS drops (FSEvents/inotify can overflow under bursty load).
 */

export interface FsWatchHandle {
  close: () => Promise<void>;
}

export interface WatchDirOptions {
  /** Glob patterns to exclude (passed through to @parcel/watcher). */
  ignore?: string[];
  /** Coalesce a burst of events into one `onChange` call. Default 150ms. */
  debounceMs?: number;
}

/**
 * Watch `dir` recursively and invoke `onChange` (debounced) on any change.
 *
 * The directory must exist; `subscribe` rejects otherwise. Callers that watch a
 * lazily-created directory should guard with an existence check and retry.
 *
 * On a watcher error (e.g. an FSEvents "must be re-scanned" overflow) we still
 * fire `onChange` — an overflow means we may have *missed* a change, so the
 * safe response is to re-check, not to stay silent. A single debounced re-check
 * is cheap and idempotent.
 */
export async function watchDir(
  dir: string,
  onChange: () => void,
  options: WatchDirOptions = {},
): Promise<FsWatchHandle> {
  const debounceMs = options.debounceMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const trigger = (): void => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, debounceMs);
    timer.unref?.();
  };

  const subscription: AsyncSubscription = await subscribe(
    dir,
    () => {
      // Both the error and success paths collapse to the same action: re-check.
      trigger();
    },
    { ignore: options.ignore },
  );

  return {
    close: async () => {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await subscription.unsubscribe();
    },
  };
}
