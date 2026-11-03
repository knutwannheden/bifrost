import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';

const execFile = promisify(execFileCb);

import { IPC, IPC_STREAM } from '../shared/ipc-channels';
import type {
  ActivityEntry,
  AddRepoParams,
  BifrostConfig,
  CaptureContextParams,
  CreateTaskParams,
  PermissionDecision,
  Repo,
} from '../shared/types';
import { getFileDiffOnDemand } from './activity-watcher';
import { getApiPort } from './bifrost-api';
import { initChangeFeed, loadChangeFeed, setActiveFeedTask } from './change-feed-service';
import { scanClaudeSessions } from './claude-session-scanner';
import { getRecentClaudeEntries, getTokenUsageData } from './claude-watcher';
import { loadConfig, mergeRendererConfig, saveConfig } from './config';
import { getConsoleSession, initConsole, resetConsole } from './console-service';
import { findTranscriptMatch, getClaudeJsonlPath, loadPersistedContexts, store as storeContext } from './context-store';
import { getCuratorState, initCurator, runCuratorNow } from './curator-service';
import { getDiff, getDiffStats, getFileStatuses, getRangeDiff, resolveDiffBase } from './diff-service';
import { applyReclaim, initDiskReclaim, scanReclaimable } from './disk-reclaim-service';
import { emit } from './event-sink';
import { getGitLog } from './git-log-service';
import { scanRecentRepos } from './history-scanner';
import { openFileInIde, openInIde } from './ide-launcher';
import { checkIntegration, installIntegration } from './integration-installer';
import { lastChangedFile } from './last-changed-file.ts';
import { createNote, deleteNote, listNotes, updateNote } from './note-store';
import { cancelTaskRequests, resolveRequest } from './permission-manager';
import { getTaskPrs } from './pr-index';
import { handleScrapeResponse, sendPrompt } from './prompt-sender';
import { addRepo, getRemotes, getRepoBranches, removeRepo } from './repo-manager';
import { attachSession, createShellSession, killSession, resizeSession, writeToSession } from './session-manager';
import { getSessionMetricsData } from './session-metrics';
import { disconnectSlack, restartPolling, startOAuth } from './slack-service';
import { getStats } from './stats-service';
import {
  archiveTaskCore,
  clearInterrupted,
  createTaskCore,
  destroyTask,
  getRemoteDiff,
  getTask,
  getTasks,
  isPendingRestore,
  isRemoteWorktreeDirty,
  refreshTaskBranches,
  regenerateTaskTitleCore,
  reopenTaskCore,
  reorderTasks,
  resolveBaseBranch,
  restoreTaskSession,
  restoreTasks,
  resumeClaudeSessionCore,
  stopTaskSession,
  transferTaskCore,
  updateTask,
} from './task-service';
import { assessStaleness, currentHead, remapAnchor } from './walkthrough-anchor';
import { generateWalkthrough, loadCurrentWalkthrough, storeWalkthrough } from './walkthrough-service';

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  initChangeFeed();

  // Load persisted context entries from DB
  loadPersistedContexts();

  restoreTasks();

  // Config
  ipcMain.handle(IPC.LOAD_CONFIG, () => loadConfig());
  ipcMain.handle(IPC.SAVE_CONFIG, (_event, config: BifrostConfig) => {
    saveConfig(mergeRendererConfig(config, loadConfig()));
    restartPolling(mainWindow);
  });
  ipcMain.handle(IPC.SET_IDE, (_event, ide: 'code' | 'idea' | 'zed') => {
    const config = loadConfig();
    config.ide = ide;
    saveConfig(config);
  });

  // Repos
  ipcMain.handle(IPC.ADD_REPO, async (_event, params: AddRepoParams) => {
    const repo = await addRepo(params);
    const config = loadConfig();
    config.repos.push(repo);
    saveConfig(config);
    emit(IPC_STREAM.REPOS_CHANGED, config.repos);
    return repo;
  });

  ipcMain.handle(IPC.REMOVE_REPO, (_event, repoId: string) => {
    const config = loadConfig();
    const updated = removeRepo(repoId, config);
    saveConfig(updated);
    emit(IPC_STREAM.REPOS_CHANGED, updated.repos);
  });

  ipcMain.handle(IPC.LIST_REPOS, () => {
    const config = loadConfig();
    return config.repos;
  });

  ipcMain.handle(IPC.GET_REPO_BRANCHES, async (_event, repoId: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    return getRepoBranches(repo.path);
  });

  ipcMain.handle(IPC.GET_CURRENT_BRANCH, async (_event, repoId: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    const { stdout } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo.path });
    return stdout.trim();
  });

  ipcMain.handle(IPC.GET_RECENT_REPOS, () => {
    const config = loadConfig();
    const excludePaths = new Set(config.repos.map((r: Repo) => r.path));
    return scanRecentRepos(excludePaths);
  });

  // Dev terminal sessions (taskId -> dev sessionId)
  const devSessions = new Map<string, string>();

  // Tasks
  ipcMain.handle(IPC.CREATE_TASK, async (_event, params: CreateTaskParams) => {
    return createTaskCore(params);
  });

  ipcMain.handle(IPC.CLOSE_TASK, async (_event, taskId: string) => {
    killSession(taskId);
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.STOP_TASK, (_event, taskId: string) => {
    const task = getTask(taskId);
    if (task.status === 'running') {
      cancelTaskRequests(taskId);
      stopTaskSession(task);
    }
    // Kill the dev terminal too
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    return updateTask(taskId, { status: 'stopped' });
  });

  ipcMain.handle(IPC.ARCHIVE_TASK, async (_event, taskId: string) => {
    return archiveTaskCore(taskId, devSessions);
  });

  ipcMain.handle(IPC.IS_WORKTREE_DIRTY, async (_event, taskId: string) => {
    const task = getTask(taskId);
    // We don't own external or in-place worktrees — skip check
    if (task.isExternal || task.inPlace) return false;
    if (task.machine) return isRemoteWorktreeDirty(task);
    if (!fs.existsSync(task.worktreePath)) return false;
    try {
      const { stdout } = await execFile('git', ['--no-optional-locks', 'status', '--porcelain'], {
        cwd: task.worktreePath,
        timeout: 5000,
      });
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  });

  ipcMain.handle(IPC.REOPEN_TASK, (_event, taskId: string) => reopenTaskCore(taskId));

  ipcMain.handle(IPC.TRANSFER_TASK, (_event, taskId: string, machine: string) => transferTaskCore(taskId, machine));

  ipcMain.handle(IPC.CLEAR_INTERRUPTED, (_event, taskId: string) => {
    clearInterrupted(taskId);
  });

  ipcMain.handle(IPC.RENAME_TASK, (_event, taskId: string, name: string) => {
    return updateTask(taskId, { name });
  });

  ipcMain.handle(IPC.REGENERATE_TASK_TITLE, (_event, taskId: string) => regenerateTaskTitleCore(taskId));

  ipcMain.handle(IPC.DELETE_TASK, async (_event, taskId: string) => {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    await destroyTask(taskId);
  });

  ipcMain.handle(IPC.LIST_TASKS, () => {
    return getTasks();
  });

  ipcMain.handle(IPC.REORDER_TASKS, (_event, taskIds: string[]) => reorderTasks(taskIds));

  ipcMain.handle(IPC.GET_TASK_PRS, () => {
    refreshTaskBranches();
    return getTaskPrs(getTasks(), loadConfig().repos);
  });

  ipcMain.handle(IPC.CREATE_DEV_TERMINAL, (_event, taskId: string) => {
    const task = getTask(taskId);
    if (task.machine) throw new Error(`A task on ${task.machine} has no dev terminal`);
    // Kill existing dev session if any
    const existing = devSessions.get(taskId);
    if (existing) killSession(existing);

    const devSessionId = `${taskId}-dev`;
    createShellSession(devSessionId, task.worktreePath, { taskId });
    devSessions.set(taskId, devSessionId);
    return devSessionId;
  });

  ipcMain.handle(IPC.CLOSE_DEV_TERMINAL, (_event, taskId: string) => {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
  });

  // Terminal sessions
  ipcMain.on(IPC.WRITE_TO_SESSION, (_event, sessionId: string, data: string) => {
    writeToSession(sessionId, data);
  });

  ipcMain.handle(IPC.RESIZE_SESSION, (_event, sessionId: string, cols: number, rows: number) => {
    resizeSession(sessionId, cols, rows);
  });

  ipcMain.handle(IPC.ATTACH_SESSION, (_event, sessionId: string, cols: number, rows: number) => {
    // A task terminal mounts before the effect that marks it active, so this is
    // where a deferred session is first asked for.
    if (isPendingRestore(sessionId)) {
      try {
        restoreTaskSession(sessionId);
      } catch (err) {
        console.error(`[ipc] Failed to restore task ${sessionId}:`, err);
        updateTask(sessionId, { status: 'error' });
      }
    }
    return attachSession(sessionId, cols, rows);
  });

  // Diff
  ipcMain.handle(IPC.GET_DIFF, async (_event, taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    if (task.machine) return getRemoteDiff(task, scope);
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getDiff(task.worktreePath, baseBranch, scope);
  });

  // File statuses (staged/unstaged/committed/untracked)
  ipcMain.handle(IPC.GET_FILE_STATUSES, async (_event, taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    if (task.machine) return {};
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getFileStatuses(task.worktreePath, baseBranch);
  });

  // Diff stats
  ipcMain.handle(IPC.GET_DIFF_STATS, async (_event, taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    if (task.machine) return null;
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getDiffStats(task.worktreePath, baseBranch, scope);
  });

  // Git log
  ipcMain.handle(IPC.GET_GIT_LOG, async (_event, taskId: string) => {
    const task = getTask(taskId);
    return getGitLog(task.worktreePath, task.baseBranch || undefined);
  });

  // Walkthrough
  // A run outlives the tab that started it, so its state is held here for whichever tab loads next.
  const generatingWalkthroughs = new Set<string>();
  const walkthroughErrors = new Map<string, string>();
  const walkthroughChanged = (taskId: string) => {
    emit(IPC_STREAM.WALKTHROUGH_UPDATED, taskId);
  };

  ipcMain.handle(IPC.WALKTHROUGH_GET, async (_event, taskId: string) => {
    const task = getTask(taskId);
    const walkthrough = loadCurrentWalkthrough(taskId);
    const staleness = walkthrough ? await assessStaleness(task.worktreePath, walkthrough) : null;
    return {
      walkthrough,
      staleness,
      generating: generatingWalkthroughs.has(taskId),
      error: walkthroughErrors.get(taskId) ?? null,
    };
  });

  ipcMain.handle(IPC.WALKTHROUGH_GENERATE, async (_event, taskId: string, focus: string | null) => {
    if (generatingWalkthroughs.has(taskId)) return { ok: false, error: 'A walkthrough is already being generated' };
    generatingWalkthroughs.add(taskId);
    walkthroughErrors.delete(taskId);
    walkthroughChanged(taskId);
    try {
      const task = getTask(taskId);
      const baseRef = await resolveBaseBranch(task);
      if (!baseRef) throw new Error('Could not resolve the base branch');
      const walkthrough = await generateWalkthrough({ worktreePath: task.worktreePath, baseRef, focus });
      storeWalkthrough(taskId, walkthrough);
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      walkthroughErrors.set(taskId, error);
      return { ok: false, error };
    } finally {
      generatingWalkthroughs.delete(taskId);
      walkthroughChanged(taskId);
    }
  });

  ipcMain.handle(IPC.WALKTHROUGH_DIFF, async (_event, taskId: string, onCurrentHead: boolean) => {
    const task = getTask(taskId);
    if (!onCurrentHead) {
      const walkthrough = loadCurrentWalkthrough(taskId);
      if (!walkthrough) return '';
      return getRangeDiff(task.worktreePath, walkthrough.change.base, walkthrough.change.head);
    }
    const baseRef = await resolveBaseBranch(task);
    const base = baseRef ? await resolveDiffBase(task.worktreePath, baseRef) : null;
    if (!base) throw new Error('Could not resolve the base branch');
    return getRangeDiff(task.worktreePath, base, await currentHead(task.worktreePath));
  });

  ipcMain.handle(IPC.WALKTHROUGH_REMAP, async (_event, taskId: string) => {
    const task = getTask(taskId);
    const walkthrough = loadCurrentWalkthrough(taskId);
    if (!walkthrough) return {};
    const head = await currentHead(task.worktreePath);
    const baseRef = await resolveBaseBranch(task);
    const base = (baseRef && (await resolveDiffBase(task.worktreePath, baseRef))) || walkthrough.change.base;
    const result: Record<string, import('../shared/walkthrough').Remapped> = {};
    for (const step of walkthrough.steps) {
      const anchored = [
        { id: step.id, anchor: step.anchor },
        ...step.comments.map((c) => ({ id: c.id, anchor: c.anchor })),
      ];
      for (const { id, anchor } of anchored) {
        if (anchor) result[id] = await remapAnchor(task.worktreePath, anchor, anchor.side === 'old' ? base : head);
      }
    }
    return result;
  });

  // PR URL
  ipcMain.handle(IPC.GET_PR_URL, async (_event, taskId: string) => {
    const task = getTask(taskId);
    try {
      const { stdout } = await execFile('gh', ['pr', 'view', '--json', 'url', '-q', '.url'], {
        cwd: task.worktreePath,
        timeout: 10000,
        killSignal: 'SIGKILL',
      });
      const url = stdout.trim();
      return url || null;
    } catch {
      return null;
    }
  });

  // Shell
  ipcMain.handle(IPC.OPEN_URL, (_event, url: string) => {
    // file:// URLs → open in configured IDE
    if (/^file:\/\//i.test(url)) {
      try {
        const parsed = new URL(url);
        const filePath = decodeURIComponent(parsed.pathname);
        const line =
          parseInt(parsed.hash.replace(/^#L?/, ''), 10) ||
          parseInt(parsed.searchParams.get('line') ?? '', 10) ||
          undefined;
        // Match file path to a task worktree so the IDE opens in the right window
        const worktree = getTasks().find(
          (t) => t.worktreePath && filePath.startsWith(`${t.worktreePath}/`),
        )?.worktreePath;
        return openFileInIde(filePath, line, worktree);
      } catch {
        return;
      }
    }
    if (!/^https?:\/\//i.test(url)) return;
    return shell.openExternal(url);
  });

  ipcMain.handle(IPC.OPEN_IN_TERMINAL, async (_event, dirPath: string) => {
    const config = loadConfig();
    const terminal = config.terminal ?? 'Terminal';
    const escaped = dirPath.replace(/'/g, "'\\''");
    let script: string;
    switch (terminal) {
      case 'iTerm':
        script = `tell application "iTerm"
  activate
  create window with default profile command "/bin/zsh"
  tell current session of current window
    write text "cd '${escaped}'"
  end tell
end tell`;
        break;
      case 'Ghostty':
        script = `do shell script "open -a Ghostty '${escaped}'"`;
        break;
      case 'Warp':
        script = `do shell script "open -a Warp '${escaped}'"`;
        break;
      default:
        script = `tell application "Terminal"
  activate
  do script "cd '${escaped}'"
end tell`;
    }
    await execFile('osascript', ['-e', script]).catch(() => {
      shell.showItemInFolder(dirPath);
    });
  });

  // IDE
  ipcMain.handle(IPC.OPEN_IN_IDE, (_event, worktreePath: string, filePath?: string, line?: number) => {
    return openInIde(worktreePath, undefined, filePath, line);
  });

  ipcMain.handle(IPC.GET_LAST_CHANGED_FILE, (_event, taskId: string) => {
    return lastChangedFile(getTask(taskId).worktreePath);
  });

  // Activity Log

  ipcMain.handle(IPC.GET_FILE_DIFF, (_event, worktreePath: string, filePath: string) => {
    return getFileDiffOnDemand(worktreePath, filePath);
  });

  // Token Usage
  ipcMain.handle(IPC.GET_TOKEN_USAGE, (_event, taskId: string) => {
    const task = getTask(taskId);
    return getTokenUsageData(task.worktreePath, task.sessionId);
  });

  ipcMain.handle(IPC.CHANGE_FEED_LOAD, (_event, taskId: string) => {
    const task = getTask(taskId);
    setActiveFeedTask(taskId);
    return loadChangeFeed(taskId, task.worktreePath, task.sessionId);
  });

  // Session Metrics
  ipcMain.handle(IPC.GET_SESSION_METRICS, async (_event, taskId: string) => {
    const task = getTask(taskId);
    return getSessionMetricsData(task.worktreePath, task.sessionId, await resolveBaseBranch(task));
  });

  // Terminal title
  ipcMain.handle(IPC.SET_TERMINAL_TITLE, (_event, _taskId: string, title: string) => {
    mainWindow.setTitle(`BIFROST — ${title}`);
  });

  // Context capture
  ipcMain.handle(IPC.CAPTURE_CONTEXT, (_event, params: CaptureContextParams) => {
    const id = storeContext(params);
    clipboard.writeText(`[Bifrost #${id}]`);
    return id;
  });

  ipcMain.handle(IPC.FIND_TRANSCRIPT_MATCH, (_event, worktreePath: string, searchText: string) => {
    const jsonlPath = getClaudeJsonlPath(worktreePath);
    if (!jsonlPath) return null;
    const match = findTranscriptMatch(jsonlPath, searchText);
    if (!match) return null;
    return { jsonlPath, ...match };
  });

  ipcMain.handle(IPC.GET_API_PORT, () => {
    return getApiPort();
  });

  // Claude sessions
  ipcMain.handle(IPC.LIST_CLAUDE_SESSIONS, () => {
    const excludePaths = new Set(getTasks().map((t) => t.worktreePath));
    return scanClaudeSessions(excludePaths);
  });

  ipcMain.handle(IPC.RESUME_CLAUDE_SESSION, (_event, externalSessionId: string, cwd: string) =>
    resumeClaudeSessionCore(externalSessionId, cwd),
  );

  // Integration
  ipcMain.handle(IPC.CHECK_INTEGRATION, () => checkIntegration());
  ipcMain.handle(IPC.INSTALL_INTEGRATION, () => installIntegration());

  ipcMain.handle(IPC.CHECK_PREREQUISITES, async () => {
    const [gitOk, claudeOk, ghOk] = await Promise.all([
      execFile('git', ['--version'], { timeout: 5000 })
        .then(() => true)
        .catch(() => false),
      execFile('claude', ['--version'], { timeout: 5000 })
        .then(() => true)
        .catch(() => false),
      execFile('gh', ['--version'], { timeout: 5000, killSignal: 'SIGKILL' })
        .then(() => true)
        .catch(() => false),
    ]);
    const plugin = checkIntegration();
    return { git: gitOk, claude: claudeOk, plugin, gh: ghOk };
  });

  ipcMain.handle(IPC.SET_ACTIVE_TASK_ID, (_event, taskId: string | null) => {
    if (taskId && isPendingRestore(taskId)) {
      try {
        restoreTaskSession(taskId);
      } catch (err) {
        console.error(`[ipc] Failed to restore task ${taskId}:`, err);
        updateTask(taskId, { status: 'error' });
      }
    }
  });

  ipcMain.handle(IPC.GET_LAST_ASSISTANT_MESSAGE, (_event, taskId: string) => {
    const task = getTask(taskId);
    const entries = getRecentClaudeEntries(taskId, task.worktreePath);
    const isAgentOutput = (e: ActivityEntry) =>
      e.claudeEventKind === 'assistant_text' ||
      (e.claudeEventKind === 'tool_use' && e.claudeToolName === 'AskUserQuestion');
    const last = [...entries].reverse().find(isAgentOutput);
    return last?.claudeText ?? null;
  });

  // Dialog
  ipcMain.handle(IPC.SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Repository Directory',
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  // Clipboard
  ipcMain.handle(IPC.READ_CLIPBOARD, () => {
    return clipboard.readText();
  });

  // gh CLI availability
  ipcMain.handle(IPC.CHECK_GH_AVAILABLE, async () => {
    try {
      await execFile('gh', ['--version'], { timeout: 5000, killSignal: 'SIGKILL' });
      return true;
    } catch {
      return false;
    }
  });

  // PR info fetch
  ipcMain.handle(IPC.FETCH_PR_INFO, async (_event, repoId: string, prNumber: number, ghRepo?: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);

    // Try gh CLI first
    try {
      const ghArgs = [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'headRefName,headRepositoryOwner,headRepository,title,number',
      ];
      if (ghRepo) ghArgs.push('--repo', ghRepo);
      const { stdout } = await execFile('gh', ghArgs, { cwd: repo.path, timeout: 10000, killSignal: 'SIGKILL' });
      const data = JSON.parse(stdout);
      const headRepoOwner = data.headRepositoryOwner?.login ?? '';
      const headRepoName = data.headRepository?.name ?? '';
      const repoOwner = (ghRepo ?? repo.githubPath)?.split('/')[0] ?? '';
      return {
        number: data.number,
        title: data.title,
        headBranch: data.headRefName,
        headRepoOwner,
        headRepoName,
        isFork: headRepoOwner !== '' && headRepoOwner !== repoOwner,
      };
    } catch {
      // gh not available or failed — fall back to git
    }

    // Fallback: git ls-remote
    const lsRemoteTarget = ghRepo ? `https://github.com/${ghRepo}.git` : 'origin';
    const { stdout: prRef } = await execFile('git', ['ls-remote', lsRemoteTarget, `refs/pull/${prNumber}/head`], {
      cwd: repo.path,
      timeout: 10000,
      killSignal: 'SIGKILL',
    });
    const prSha = prRef.split('\t')[0];
    if (!prSha) throw new Error(`PR #${prNumber} not found`);

    // Try to find the branch name by matching SHA against remote refs
    let headBranch = `pull/${prNumber}/head`;
    try {
      const { stdout: refs } = await execFile('git', ['ls-remote', '--heads', lsRemoteTarget], {
        cwd: repo.path,
        timeout: 10000,
        killSignal: 'SIGKILL',
      });
      for (const line of refs.split('\n')) {
        const [sha, ref] = line.split('\t');
        if (sha === prSha && ref) {
          headBranch = ref.replace('refs/heads/', '');
          break;
        }
      }
    } catch {
      // ignore, use fallback branch name
    }

    return {
      number: prNumber,
      headBranch,
      headRepoOwner: '',
      headRepoName: '',
      isFork: false,
    };
  });

  // Match repo for PR (checks all remotes across configured repos)
  ipcMain.handle(IPC.MATCH_REPO_FOR_PR, async (_event, owner: string, repoName: string) => {
    const config = loadConfig();
    const target = `${owner}/${repoName}`.toLowerCase();
    for (const repo of config.repos) {
      const remotes = await getRemotes(repo.path);
      if (remotes.some((r) => r.githubPath.toLowerCase() === target)) {
        return repo.id;
      }
    }
    return null;
  });

  // Notes
  ipcMain.handle(IPC.NOTE_LIST, (_event, repoId: string) => {
    return listNotes(repoId);
  });

  ipcMain.handle(IPC.NOTE_CREATE, (_event, repoId: string, text: string) => {
    return createNote(repoId, text);
  });

  ipcMain.handle(
    IPC.NOTE_UPDATE,
    (_event, repoId: string, noteId: string, updates: { text?: string; addressed?: boolean }) => {
      return updateNote(repoId, noteId, updates);
    },
  );

  ipcMain.handle(IPC.NOTE_DELETE, (_event, repoId: string, noteId: string) => {
    deleteNote(repoId, noteId);
  });

  // Permission
  ipcMain.handle(IPC.RESOLVE_PERMISSION, (_event, requestId: string, decision: PermissionDecision) => {
    resolveRequest(requestId, decision);
  });

  // Stats
  ipcMain.handle(IPC.GET_STATS, (_event, since?: number) =>
    getStats((data) => {
      emit(IPC_STREAM.STATS_UPDATE, data);
    }, since),
  );

  initCurator(mainWindow);
  initDiskReclaim(mainWindow);
  initConsole();

  // Curator
  ipcMain.handle(IPC.CURATOR_GET_STATE, () => getCuratorState());
  ipcMain.handle(IPC.CURATOR_SET_OUTCOME, (_event, taskId: string, outcome: string, note?: string) => {
    const task = getTask(taskId);
    const curation = {
      ...(task.curation ?? { outcome: 'pending' as const, confidence: 'user' as const, classifiedAt: Date.now() }),
      userOverride: outcome as import('../shared/types').TaskOutcome,
      userNote: note,
      classifiedAt: Date.now(),
    };
    return updateTask(taskId, { curation });
  });
  ipcMain.handle(IPC.CURATOR_RUN_NOW, () => runCuratorNow());

  // Console
  ipcMain.handle(IPC.CONSOLE_SESSION, () => getConsoleSession());
  ipcMain.handle(IPC.CONSOLE_RESET, () => resetConsole());

  // Disk reclaim
  ipcMain.handle(IPC.DISK_RECLAIM_SCAN, () => scanReclaimable());
  ipcMain.handle(IPC.DISK_RECLAIM_APPLY, (_event, worktreePaths: string[]) => applyReclaim(worktreePaths));

  // Slack
  ipcMain.handle(IPC.SLACK_START_OAUTH, () => startOAuth(mainWindow));
  ipcMain.handle(IPC.SLACK_DISCONNECT, () => disconnectSlack());
  // Prompt sender
  ipcMain.handle(
    IPC.SEND_PROMPT,
    (_event, taskId: string, text: string, mode?: 'direct' | 'queue' | 'only-when-idle') => {
      return sendPrompt(taskId, text, mode || 'direct');
    },
  );
  ipcMain.handle(IPC.SCRAPE_PROMPT_RESPONSE, (_event, requestId: string, text: string) => {
    handleScrapeResponse(requestId, text);
  });
}
