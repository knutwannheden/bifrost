import { execFile as execFileCb } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

import { IPC, IPC_STREAM, type IpcChannel } from '../shared/ipc-channels';
import { promptDraft } from '../shared/prompt-draft';
import type {
  ActivityEntry,
  AddRepoParams,
  CreateTaskParams,
  PermissionDecision,
  Repo,
  SessionState,
} from '../shared/types';
import { getFileDiffOnDemand } from './activity-watcher';
import { getApiPort } from './bifrost-api';
import { loadChangeFeed, setActiveFeedTask } from './change-feed-service';
import { scanClaudeSessions } from './claude-session-scanner';
import { getRecentClaudeEntries, getTokenUsageData } from './claude-watcher';
import { loadConfig, saveConfig } from './config';
import { getConsoleSession, getMachineConsole, resetConsole, resetMachineConsole } from './console-service';
import { findTranscriptMatch, getClaudeJsonlPath } from './context-store';
import { getCuratorState, runCuratorNow } from './curator-service';
import { getDiff, getDiffStats, getFileStatuses, getRangeDiff, resolveDiffBase } from './diff-service';
import { applyReclaim, scanReclaimable } from './disk-reclaim-service';
import { emit } from './event-sink';
import { getGitLog } from './git-log-service';
import { scanRecentRepos } from './history-scanner';
import { checkIntegration, installIntegration } from './integration-installer';
import { lastChangedFile } from './last-changed-file.ts';
import { createNote, deleteNote, listNotes, updateNote } from './note-store';
import { connectPeer, peerOf, peerTasks, routeCall } from './peers';
import { cancelTaskRequests, resolveRequest } from './permission-manager';
import { getTaskPrs } from './pr-index';
import { handleScrapeResponse, isIdle, sendPrompt } from './prompt-sender';
import { captureScript, getRemoteHost, LOGIN_SESSION } from './remote-host';
import { addRepo, getRemotes, getRepoBranches, removeRepo } from './repo-manager';
import {
  attachSession,
  captureLocalSession,
  createRemoteSession,
  createShellSession,
  detachSession,
  hasSession,
  killSession,
  resizeSession,
  writeToSession,
} from './session-manager';
import { getSessionMetricsData } from './session-metrics';
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
  resumeClaudeSessionCore,
  stopTaskSession,
  transferTaskCore,
  updateTask,
} from './task-service';
import { assessStaleness, currentHead, remapAnchor } from './walkthrough-anchor';
import { generateWalkthrough, loadCurrentWalkthrough, storeWalkthrough } from './walkthrough-service';

// Dev terminal sessions (taskId -> dev sessionId)
const devSessions = new Map<string, string>();
// Walkthrough
// A run outlives the tab that started it, so its state is held here for whichever tab loads next.
const generatingWalkthroughs = new Set<string>();
const walkthroughErrors = new Map<string, string>();
const walkthroughChanged = (taskId: string) => {
  emit(IPC_STREAM.WALKTHROUGH_UPDATED, taskId);
};

/** The IPC calls that need no window, by channel, so the renderer's and another instance's run the same code. */
// biome-ignore lint/suspicious/noExplicitAny: each call declares its own arguments
export const calls: Partial<Record<IpcChannel, (...args: any[]) => unknown>> = {
  // Config
  [IPC.LOAD_CONFIG]: () => loadConfig(),

  [IPC.SET_IDE]: (ide: 'code' | 'idea' | 'zed') => {
    const config = loadConfig();
    config.ide = ide;
    saveConfig(config);
  },

  // Repos
  [IPC.ADD_REPO]: async (params: AddRepoParams) => {
    const repo = await addRepo(params);
    const config = loadConfig();
    config.repos.push(repo);
    saveConfig(config);
    emit(IPC_STREAM.REPOS_CHANGED, config.repos);
    return repo;
  },

  [IPC.REMOVE_REPO]: (repoId: string) => {
    const config = loadConfig();
    const updated = removeRepo(repoId, config);
    saveConfig(updated);
    emit(IPC_STREAM.REPOS_CHANGED, updated.repos);
  },

  [IPC.LIST_REPOS]: () => {
    const config = loadConfig();
    return config.repos;
  },

  [IPC.GET_REPO_BRANCHES]: async (repoId: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    return getRepoBranches(repo.path);
  },

  [IPC.GET_CURRENT_BRANCH]: async (repoId: string) => {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === repoId);
    if (!repo) throw new Error(`Repo not found: ${repoId}`);
    const { stdout } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo.path });
    return stdout.trim();
  },

  [IPC.GET_RECENT_REPOS]: () => {
    const config = loadConfig();
    const excludePaths = new Set(config.repos.map((r: Repo) => r.path));
    return scanRecentRepos(excludePaths);
  },

  // Tasks
  [IPC.CREATE_TASK]: async (params: CreateTaskParams) => {
    return createTaskCore(params);
  },

  [IPC.CLOSE_TASK]: async (taskId: string) => {
    killSession(taskId);
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    await destroyTask(taskId);
  },

  [IPC.SESSION_STATE]: async (taskId: string): Promise<SessionState> => {
    const { machine } = getTask(taskId);
    const screen = machine
      ? await getRemoteHost(machine)
          .exec(captureScript(taskId))
          .catch(() => null)
      : await captureLocalSession(taskId);
    return { live: screen !== null, busy: !isIdle(taskId), draft: screen === null ? '' : promptDraft(screen) };
  },

  [IPC.STOP_TASK]: (taskId: string) => {
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
  },

  [IPC.ARCHIVE_TASK]: async (taskId: string) => {
    return archiveTaskCore(taskId, devSessions);
  },

  [IPC.IS_WORKTREE_DIRTY]: async (taskId: string) => {
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
  },

  [IPC.REOPEN_TASK]: (taskId: string) => reopenTaskCore(taskId),

  [IPC.TRANSFER_TASK]: (taskId: string, machine: string) => transferTaskCore(taskId, machine),

  [IPC.CLEAR_INTERRUPTED]: (taskId: string) => {
    clearInterrupted(taskId);
  },

  [IPC.RENAME_TASK]: (taskId: string, name: string) => {
    return updateTask(taskId, { name });
  },

  [IPC.REGENERATE_TASK_TITLE]: (taskId: string) => regenerateTaskTitleCore(taskId),

  [IPC.DELETE_TASK]: async (taskId: string) => {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
    await destroyTask(taskId);
  },

  [IPC.LIST_TASKS]: () => {
    return getTasks();
  },

  [IPC.REORDER_TASKS]: (taskIds: string[]) => reorderTasks(taskIds),

  [IPC.GET_TASK_PRS]: () => {
    refreshTaskBranches();
    return getTaskPrs(getTasks(), loadConfig().repos);
  },

  [IPC.CREATE_DEV_TERMINAL]: (taskId: string) => {
    const task = getTask(taskId);
    if (task.machine) throw new Error(`A task on ${task.machine} has no dev terminal`);
    // Kill existing dev session if any
    const existing = devSessions.get(taskId);
    if (existing) killSession(existing);

    const devSessionId = `${taskId}-dev`;
    createShellSession(devSessionId, task.worktreePath, { taskId });
    devSessions.set(taskId, devSessionId);
    return devSessionId;
  },

  [IPC.CLOSE_DEV_TERMINAL]: (taskId: string) => {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
  },

  // Terminal sessions
  [IPC.WRITE_TO_SESSION]: (sessionId: string, data: string) => {
    writeToSession(sessionId, data);
  },

  [IPC.RESIZE_SESSION]: (sessionId: string, cols: number, rows: number) => {
    resizeSession(sessionId, cols, rows);
  },

  [IPC.ATTACH_SESSION]: async (sessionId: string, cols: number, rows: number) => {
    const peer = peerOf(sessionId);
    if (peer) {
      // Joining over ssh would start a session the owner has stopped, since the client creates one it does not find.
      const task = peerTasks().find((t) => t.id === sessionId);
      if (task?.status !== 'running') return false;
      // The owner starts a session it deferred, and this side reads it over ssh as any remote tab does.
      await routeCall(IPC.SET_ACTIVE_TASK_ID, [sessionId], () => undefined);
      if (!hasSession(sessionId)) createRemoteSession(sessionId, getRemoteHost(peer), { name: task.name });
      return attachSession(sessionId, cols, rows);
    }
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
  },

  // Diff
  [IPC.GET_DIFF]: async (taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    if (task.machine) return getRemoteDiff(task, scope);
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getDiff(task.worktreePath, baseBranch, scope);
  },

  // File statuses (staged/unstaged/committed/untracked)
  [IPC.GET_FILE_STATUSES]: async (taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    if (task.machine) return {};
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getFileStatuses(task.worktreePath, baseBranch);
  },

  // Diff stats
  [IPC.GET_DIFF_STATS]: async (taskId: string, scope?: 'working' | 'all') => {
    const task = getTask(taskId);
    if (task.machine) return null;
    const baseBranch = scope === 'all' ? await resolveBaseBranch(task) : undefined;
    return getDiffStats(task.worktreePath, baseBranch, scope);
  },

  // Git log
  [IPC.GET_GIT_LOG]: async (taskId: string) => {
    const task = getTask(taskId);
    return getGitLog(task.worktreePath, task.baseBranch || undefined);
  },

  [IPC.WALKTHROUGH_GET]: async (taskId: string) => {
    const task = getTask(taskId);
    const walkthrough = loadCurrentWalkthrough(taskId);
    const staleness = walkthrough ? await assessStaleness(task.worktreePath, walkthrough) : null;
    return {
      walkthrough,
      staleness,
      generating: generatingWalkthroughs.has(taskId),
      error: walkthroughErrors.get(taskId) ?? null,
    };
  },

  [IPC.WALKTHROUGH_GENERATE]: async (taskId: string, focus: string | null) => {
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
  },

  [IPC.WALKTHROUGH_DIFF]: async (taskId: string, onCurrentHead: boolean) => {
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
  },

  [IPC.WALKTHROUGH_REMAP]: async (taskId: string) => {
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
  },

  // PR URL
  [IPC.GET_PR_URL]: async (taskId: string) => {
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
  },

  [IPC.GET_LAST_CHANGED_FILE]: (taskId: string) => {
    return lastChangedFile(getTask(taskId).worktreePath);
  },

  // Activity Log
  [IPC.GET_FILE_DIFF]: (worktreePath: string, filePath: string) => {
    return getFileDiffOnDemand(worktreePath, filePath);
  },

  // Token Usage
  [IPC.GET_TOKEN_USAGE]: (taskId: string) => {
    const task = getTask(taskId);
    return getTokenUsageData(task.worktreePath, task.sessionId);
  },

  [IPC.CHANGE_FEED_LOAD]: (taskId: string) => {
    const task = getTask(taskId);
    setActiveFeedTask(taskId);
    return loadChangeFeed(taskId, task.worktreePath, task.sessionId);
  },

  // Session Metrics
  [IPC.GET_SESSION_METRICS]: async (taskId: string) => {
    const task = getTask(taskId);
    return getSessionMetricsData(task.worktreePath, task.sessionId, await resolveBaseBranch(task));
  },

  [IPC.FIND_TRANSCRIPT_MATCH]: (worktreePath: string, searchText: string) => {
    const jsonlPath = getClaudeJsonlPath(worktreePath);
    if (!jsonlPath) return null;
    const match = findTranscriptMatch(jsonlPath, searchText);
    if (!match) return null;
    return { jsonlPath, ...match };
  },

  [IPC.GET_API_PORT]: () => {
    return getApiPort();
  },

  // Claude sessions
  [IPC.LIST_CLAUDE_SESSIONS]: () => {
    const excludePaths = new Set(getTasks().map((t) => t.worktreePath));
    return scanClaudeSessions(excludePaths);
  },

  [IPC.RESUME_CLAUDE_SESSION]: (externalSessionId: string, cwd: string) =>
    resumeClaudeSessionCore(externalSessionId, cwd),

  // Integration
  [IPC.CHECK_INTEGRATION]: () => checkIntegration(),

  [IPC.INSTALL_INTEGRATION]: () => installIntegration(),

  [IPC.CHECK_PREREQUISITES]: async () => {
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
  },

  [IPC.SET_ACTIVE_TASK_ID]: (taskId: string | null) => {
    if (taskId && isPendingRestore(taskId)) {
      try {
        restoreTaskSession(taskId);
      } catch (err) {
        console.error(`[ipc] Failed to restore task ${taskId}:`, err);
        updateTask(taskId, { status: 'error' });
      }
    }
  },

  [IPC.GET_LAST_ASSISTANT_MESSAGE]: (taskId: string) => {
    const task = getTask(taskId);
    const entries = getRecentClaudeEntries(taskId, task.worktreePath);
    const isAgentOutput = (e: ActivityEntry) =>
      e.claudeEventKind === 'assistant_text' ||
      (e.claudeEventKind === 'tool_use' && e.claudeToolName === 'AskUserQuestion');
    const last = [...entries].reverse().find(isAgentOutput);
    return last?.claudeText ?? null;
  },

  // gh CLI availability
  [IPC.CHECK_GH_AVAILABLE]: async () => {
    try {
      await execFile('gh', ['--version'], { timeout: 5000, killSignal: 'SIGKILL' });
      return true;
    } catch {
      return false;
    }
  },

  // PR info fetch
  [IPC.FETCH_PR_INFO]: async (repoId: string, prNumber: number, ghRepo?: string) => {
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
  },

  // Match repo for PR (checks all remotes across configured repos)
  [IPC.MATCH_REPO_FOR_PR]: async (owner: string, repoName: string) => {
    const config = loadConfig();
    const target = `${owner}/${repoName}`.toLowerCase();
    for (const repo of config.repos) {
      const remotes = await getRemotes(repo.path);
      if (remotes.some((r) => r.githubPath.toLowerCase() === target)) {
        return repo.id;
      }
    }
    return null;
  },

  // Notes
  [IPC.NOTE_LIST]: (repoId: string) => {
    return listNotes(repoId);
  },

  [IPC.NOTE_CREATE]: (repoId: string, text: string) => {
    return createNote(repoId, text);
  },

  [IPC.NOTE_UPDATE]: (repoId: string, noteId: string, updates: { text?: string; addressed?: boolean }) => {
    return updateNote(repoId, noteId, updates);
  },

  [IPC.NOTE_DELETE]: (repoId: string, noteId: string) => {
    deleteNote(repoId, noteId);
  },

  // Permission
  [IPC.RESOLVE_PERMISSION]: (requestId: string, decision: PermissionDecision) => {
    resolveRequest(requestId, decision);
  },

  // Stats
  [IPC.GET_STATS]: (since?: number) =>
    getStats((data) => {
      emit(IPC_STREAM.STATS_UPDATE, data);
    }, since),

  // Curator
  [IPC.CURATOR_GET_STATE]: () => getCuratorState(),

  [IPC.CURATOR_SET_OUTCOME]: (taskId: string, outcome: string, note?: string) => {
    const task = getTask(taskId);
    const curation = {
      ...(task.curation ?? { outcome: 'pending' as const, confidence: 'user' as const, classifiedAt: Date.now() }),
      userOverride: outcome as import('../shared/types').TaskOutcome,
      userNote: note,
      classifiedAt: Date.now(),
    };
    return updateTask(taskId, { curation });
  },

  [IPC.CURATOR_RUN_NOW]: () => runCuratorNow(),

  // Console
  [IPC.CONSOLE_SESSION]: (machine?: string) => (machine ? getMachineConsole(machine) : getConsoleSession()),

  [IPC.MACHINE_LOGIN_START]: async (machine: string) => {
    const host = getRemoteHost(machine);
    await host.prepareLogin();
    const id = `${LOGIN_SESSION}@${machine}`;
    detachSession(id);
    createRemoteSession(id, host, { name: LOGIN_SESSION, tmuxName: LOGIN_SESSION });
    return id;
  },

  [IPC.MACHINE_LOGIN_CHECK]: async (machine: string) => {
    const loggedIn = await getRemoteHost(machine).checkLogin();
    // A machine that runs its own instance comes back at once. A machine without one has no peer to connect.
    if (loggedIn) connectPeer(machine).catch(() => {});
    return loggedIn;
  },

  [IPC.CONSOLE_RESET]: (machine?: string) => (machine ? resetMachineConsole(machine) : resetConsole()),

  // Disk reclaim
  [IPC.DISK_RECLAIM_SCAN]: () => scanReclaimable(),

  [IPC.DISK_RECLAIM_APPLY]: (worktreePaths: string[]) => applyReclaim(worktreePaths),

  // Prompt sender
  [IPC.SEND_PROMPT]: (taskId: string, text: string, mode?: 'direct' | 'queue' | 'only-when-idle') => {
    return sendPrompt(taskId, text, mode || 'direct');
  },

  [IPC.SCRAPE_PROMPT_RESPONSE]: (requestId: string, text: string) => {
    handleScrapeResponse(requestId, text);
  },
};
