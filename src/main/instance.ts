import { stopAllWatching } from './activity-watcher.ts';
import { initApi, startApi, stopApi } from './bifrost-api.ts';
import { initChangeFeed } from './change-feed-service.ts';
import { recordClaudeConfigDir } from './claude-paths.ts';
import { initConsole } from './console-service.ts';
import { loadPersistedContexts } from './context-store.ts';
import { initCurator } from './curator-service.ts';
import { closeDatabase, openDatabase } from './db.ts';
import { closePeers } from './peers.ts';
import { closeRemoteHosts } from './remote-host.ts';
import { detachAllSessions } from './session-manager.ts';
import { restoreTasks } from './task-service.ts';

/**
 * Starts the services a Bifrost instance runs, and answers the port its API
 * listens on, or null when none was free. A window, if there is one, is the caller's.
 */
export async function startInstance(): Promise<number | null> {
  recordClaudeConfigDir();
  const port = await startApi();
  openDatabase();
  initChangeFeed();
  loadPersistedContexts();
  restoreTasks();
  initCurator();
  initConsole();
  initApi();
  return port;
}

/** Stops them again. The sessions in tmux run on. */
export async function stopInstance(): Promise<void> {
  stopAllWatching();
  detachAllSessions();
  closeRemoteHosts();
  closePeers();
  await stopApi();
  closeDatabase();
}
