import { stopAllWatching } from './activity-watcher.ts';
import { initApi, startApi, stopApi } from './bifrost-api.ts';
import { initChangeFeed } from './change-feed-service.ts';
import { applyClaudeConfigDir, recordClaudeConfigDir } from './claude-paths.ts';
import { loadConfig } from './config.ts';
import { initConsole } from './console-service.ts';
import { loadPersistedContexts } from './context-store.ts';
import { initCurator } from './curator-service.ts';
import { closeDatabase, openDatabase } from './db.ts';
import { closePeers } from './peers.ts';
import { closeRemoteHosts } from './remote-host.ts';
import { detachAllSessions } from './session-manager.ts';
import { refreshTaskBranches, restoreTasks } from './task-service.ts';

/** How often an instance re-reads its tasks' branches, with or without a window asking for their PRs. */
const BRANCH_REFRESH_MS = 30_000;
let branchRefresh: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the services a Bifrost instance runs, and answers the port its API
 * listens on, or null when none was free. A window, if there is one, is the caller's.
 */
export async function startInstance(): Promise<number | null> {
  applyClaudeConfigDir(loadConfig().claudeConfigDir);
  recordClaudeConfigDir();
  const port = await startApi();
  openDatabase();
  initChangeFeed();
  loadPersistedContexts();
  restoreTasks();
  initCurator();
  initConsole();
  initApi();
  branchRefresh = setInterval(refreshTaskBranches, BRANCH_REFRESH_MS);
  return port;
}

/** Stops them again. The sessions in tmux run on. */
export async function stopInstance(): Promise<void> {
  if (branchRefresh) clearInterval(branchRefresh);
  branchRefresh = null;
  stopAllWatching();
  detachAllSessions();
  closeRemoteHosts();
  closePeers();
  await stopApi();
  closeDatabase();
}
