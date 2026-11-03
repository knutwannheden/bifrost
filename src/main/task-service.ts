import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

import { IPC_STREAM } from '../shared/ipc-channels.ts';
import { generateTaskName } from '../shared/name-generator.ts';
import type { CreateTaskParams, DiffResult, Repo, Task } from '../shared/types.ts';
import { startWatching, stopWatching } from './activity-watcher.ts';
import { isSessionStale } from './bifrost-api.ts';
import { forgetChangeFeed } from './change-feed-service.ts';
import { lastConversationAt } from './claude-watcher.ts';
import { loadConfig, saveConfig } from './config.ts';
import { resolveBaseRef } from './diff-service.ts';
import { emit } from './event-sink.ts';
import { handOver, isInstanceMachine } from './instance-link.ts';
import { cancelTaskRequests, setWorktreePathResolver } from './permission-manager.ts';
import {
  archiveScript,
  diffScript,
  getRemoteHost,
  localClaudeValue,
  machineSession,
  parseScriptOutput,
  type RemoteHost,
  type RemoteInfo,
  remoteClonePath,
  remoteSessionSettings,
  restoreWorktreeScript,
  sessionSetupScript,
  statusScript,
  stopSessionScript,
  worktreeScript,
} from './remote-host.ts';
import { addRepo, matchRepo } from './repo-manager.ts';
import { planRestore } from './restore-plan.ts';
import {
  attachLocalSession,
  claudeArgs,
  claudeEnv,
  createRemoteSession,
  getSessionName,
  hasSession,
  killSession,
  runningLocalSessions,
} from './session-manager.ts';
import { loadTasks, saveInterrupted, saveTasks, saveTurnBoundaries, saveTurnBoundary } from './task-store.ts';
import { claudeProjectDir, packTask, unpackScript } from './task-transfer.ts';
import { generateTaskTitle } from './title-generator.ts';
import { writeLocalSession } from './tmux-session.ts';
import {
  cleanupMultiRepoContainer,
  createMultiRepoContainer,
  createWorktree,
  createWorktreeFromPr,
  headBranch,
  inspectWorktree,
  removeWorktree,
  restoreWorktree,
  slugify,
} from './worktree-manager.ts';

// In-memory task list, synced to disk
let tasks: Task[] = [];

// Set by restoreTasks(), used wherever a task starts being watched
let _claudeCallbacks: { onSummary: (taskId: string, summary: string) => void } | null = null;

// Tasks whose sessions are deferred until their tab is activated
const pendingRestore = new Set<string>();

export function getTasks(): Task[] {
  return tasks;
}

export function getTask(taskId: string): Task {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

export function markTurnBoundary(taskId: string, at: number): void {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;
  task.lastTurnBoundaryAt = at;
  saveTurnBoundary(taskId, at);
  // A turn of any kind means the task is going again, whatever cut the last one off.
  if (task.interruptedAt != null) clearInterrupted(taskId);
}

export function clearInterrupted(taskId: string): void {
  const task = tasks.find((t) => t.id === taskId);
  if (!task?.interruptedAt) return;
  task.interruptedAt = undefined;
  saveInterrupted([taskId], null);
}

/** Worktree removals still running, so a reopen can wait for its own. */
const cleanups = new Map<string, Promise<void>>();

/**
 * The hooks reach Bifrost only while it runs, so the transcripts supply both
 * the turns taken meanwhile and every task's first position.
 */
function seedTurnBoundaries(loaded: Task[]): void {
  const stamps: Array<[string, number]> = [];
  for (const task of loaded) {
    const at = lastConversationAt(task.worktreePath);
    if (at == null || at <= (task.lastTurnBoundaryAt ?? 0)) continue;
    task.lastTurnBoundaryAt = at;
    stamps.push([task.id, at]);
  }
  saveTurnBoundaries(stamps);
}

export function updateTask(taskId: string, updates: Partial<Task>): Task {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) throw new Error(`Task not found: ${taskId}`);
  tasks[idx] = { ...tasks[idx], ...updates };
  saveTasks(tasks);
  return tasks[idx];
}

/**
 * Point each open task at the branch its worktree has checked out. A session
 * that moves to a second branch opens its next PR there, and both the task's
 * PR and its curated outcome are found by branch.
 */
export function refreshTaskBranches(): void {
  let moved = false;
  for (const [i, task] of tasks.entries()) {
    if (task.archivedAt || task.machine) continue;
    const branch = headBranch(task.worktreePath);
    if (branch && branch !== task.branch) {
      tasks[i] = { ...task, branch };
      moved = true;
    }
  }
  if (moved) saveTasks(tasks);
}

/**
 * Rename the worktree's branch, returning the new name or null when left alone.
 * HEAD is the source of truth for which branch that is, since it's observed
 * rather than stored. In-place tasks sit on the repo's own checked-out branch,
 * which is never ours to rename.
 */
async function renameWorktreeBranch(task: Task, candidate: string): Promise<string | null> {
  if (task.isExternal || task.inPlace || !candidate) return null;
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFile('git', args, { cwd: task.worktreePath, timeout: 5000 });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  // Fails on a detached HEAD, which has no branch to rename.
  const current = await git(['symbolic-ref', '--short', 'HEAD']);
  if (!current || current === candidate) return null;
  // Branching a worktree off a remote ref inherits tracking from it, so an
  // upstream says nothing about this branch. A remote ref under its own name
  // does; treat an unreadable answer as pushed rather than risk the rename.
  const pushed = await git(['for-each-ref', '--format=%(refname)', `refs/remotes/*/${current}`]);
  if (pushed === null || pushed !== '') return null;
  if (await git(['rev-parse', '--verify', candidate])) return null;
  return (await git(['branch', '-m', current, candidate])) === null ? null : candidate;
}

export async function archiveTaskCore(taskId: string, devSessions?: Map<string, string>): Promise<Task> {
  cancelTaskRequests(taskId);
  const task = getTask(taskId);
  stopWatching(taskId);
  if (devSessions) {
    const devSessionId = devSessions.get(taskId);
    if (devSessionId) {
      killSession(devSessionId);
      devSessions.delete(taskId);
    }
  }
  if (task.status === 'running') {
    killSession(taskId);
  }
  forgetChangeFeed(taskId);
  const updates: Partial<Task> = { status: 'archived', archivedAt: Date.now() };
  let removal: (() => Promise<void>) | null = null;

  const host = remoteHostFor(task);
  if (host) {
    // The branch is read there as the worktree goes, so it is recorded once removal reports it.
    removal = () =>
      host.exec(archiveScript(task.id, task.worktreePath)).then((out) => {
        const branch = parseScriptOutput(out).BRANCH;
        if (branch && branch !== task.branch) updateTask(taskId, { branch });
      });
  } else if (!task.isExternal && !task.machine && fs.existsSync(task.worktreePath)) {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === task.repoId);
    if (repo?.multiTaskId === task.id) {
      // Multi-repo cleanup: remove constituent worktrees, container dir, and container repo
      removal = () => cleanupMultiRepoContainer(task.worktreePath);
      config.repos = config.repos.filter((r: Repo) => r.id !== repo.id);
      saveConfig(config);
    } else if (!task.inPlace && repo) {
      // The branch holds the commits, so reopening builds the worktree back from
      // it — which is why uncommitted work is worth a confirmation and commits
      // are not. A detached HEAD has no branch to build from, so it stays.
      const branch = headBranch(task.worktreePath);
      if (branch) {
        updates.branch = branch;
        removal = () => removeWorktree(repo.path, task.worktreePath);
      }
    }
  }

  const archived = updateTask(taskId, updates);
  if (removal) {
    // Deleting a checkout runs to seconds, and the task is archived either way,
    // so the caller is answered now and reopening waits on this instead.
    const done = removal()
      .catch((err) => console.error(`[archive] could not remove worktree ${task.worktreePath}:`, err))
      .finally(() => {
        if (cleanups.get(taskId) === done) cleanups.delete(taskId);
      });
    cleanups.set(taskId, done);
  }
  return archived;
}

/**
 * Resolve the effective base branch for diff comparison.
 * Tries repo.defaultBranch (preferring remote-tracking refs), then origin/HEAD,
 * then origin/main or origin/master as last resort. All local operations, no network.
 */
export async function resolveBaseBranch(task: Task): Promise<string | undefined> {
  // Wrap with a timeout so we never block the UI indefinitely
  const result = await Promise.race([
    resolveBaseBranchInner(task),
    new Promise<undefined>((resolve) => setTimeout(resolve, 8000)),
  ]);
  return result;
}

async function resolveBaseBranchInner(task: Task): Promise<string | undefined> {
  // task.baseBranch is the ref the worktree was forked from — the actual fork point
  if (task.baseBranch) {
    const ref = await resolveBaseRef(task.worktreePath, task.baseBranch);
    if (ref) return ref;
  }

  // Fallback: repo's configured default branch
  const config = loadConfig();
  const repo = config.repos.find((r: Repo) => r.id === task.repoId);
  if (repo?.defaultBranch) {
    const ref = await resolveBaseRef(task.worktreePath, repo.defaultBranch);
    if (ref) return ref;
  }

  // Fallback: origin/HEAD
  try {
    const { stdout } = await execFile('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: task.worktreePath,
      timeout: 5000,
    });
    const branch = stdout.trim().replace(/^refs\/remotes\/origin\//, '');
    if (branch) return `origin/${branch}`;
  } catch {
    /* origin/HEAD not set */
  }

  // Last resort: origin/main or origin/master
  for (const candidate of ['main', 'master']) {
    try {
      await execFile('git', ['rev-parse', '--verify', `origin/${candidate}`], {
        cwd: task.worktreePath,
        timeout: 5000,
      });
      return `origin/${candidate}`;
    } catch {
      /* doesn't exist */
    }
  }

  return undefined;
}

export async function destroyTask(taskId: string): Promise<void> {
  cancelTaskRequests(taskId);
  const task = getTask(taskId);
  stopWatching(taskId);
  if (task.status === 'running') {
    killSession(taskId);
  }
  const host = remoteHostFor(task);
  if (host) {
    cleanups.set(
      taskId,
      host
        .exec(archiveScript(task.id, task.worktreePath))
        .then(() => undefined)
        .catch((err) => console.warn(`[delete] ${task.machine}: ${(err as Error).message}`))
        .finally(() => cleanups.delete(taskId)),
    );
  } else if (!task.machine && fs.existsSync(task.worktreePath)) {
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === task.repoId);
    if (repo?.multiTaskId === task.id) {
      try {
        await cleanupMultiRepoContainer(task.worktreePath);
      } catch {
        /* best effort */
      }
      config.repos = config.repos.filter((r: Repo) => r.id !== repo.id);
      saveConfig(config);
    } else if (!task.inPlace && repo) {
      // Backgrounded for the same reason as archiving: the row should not wait
      // on a directory delete, and the task is gone from the list either way.
      cleanups.set(
        taskId,
        removeWorktree(repo.path, task.worktreePath)
          .catch(() => {
            /* Worktree may already be removed */
          })
          .finally(() => cleanups.delete(taskId)),
      );
    }
  }
  tasks = tasks.filter((t) => t.id !== taskId);
  saveTasks(tasks);
}

async function createMultiRepoTask(params: CreateTaskParams): Promise<Task> {
  const config = loadConfig();
  const selectedRepos = params.multiRepoIds!.map((id) => {
    const repo = config.repos.find((r: Repo) => r.id === id);
    if (!repo) throw new Error(`Repo not found: ${id}`);
    return repo;
  });

  const name = params.name || generateTaskName();
  const taskId = randomUUID();
  const taskSlug = slugify(name);

  const { containerPath } = await createMultiRepoContainer(taskSlug, selectedRepos);

  // Register container as a Repo
  const containerRepo: Repo = {
    id: randomUUID(),
    name: taskSlug,
    path: containerPath,
    defaultBranch: 'main',
    multiTaskId: taskId,
  };
  config.repos.push(containerRepo);
  saveConfig(config);

  const task: Task = {
    id: taskId,
    name,
    repoId: containerRepo.id,
    baseBranch: 'main',
    branch: 'main',
    worktreePath: containerPath,
    sessionId: randomUUID(),
    status: 'running',
    hasUnread: false,
    createdAt: Date.now(),
    ...(params.prompt ? { summary: params.prompt } : {}),
    ...(params.createdByTaskId ? { createdByTaskId: params.createdByTaskId } : {}),
  };
  startLocalSession(
    task,
    params.prompt ? params.prompt + creatorCoordinates(params.createdByTaskId, taskId) : undefined,
  );

  tasks.push(task);
  saveTasks(tasks);

  if (!_claudeCallbacks) throw new Error('Tasks not yet restored');
  startWatching(task.id, containerPath, _claudeCallbacks);

  return task;
}

/**
 * Tells a new task how to reach whoever asked for it, which it otherwise has
 * no way to learn, and names the task's own id alongside so the two are not
 * confused. Composed here so it reaches the session's first prompt
 * without landing in the task's summary, which is shown and searched.
 */
function creatorCoordinates(createdByTaskId: string | undefined, taskId: string, machine?: string): string {
  if (!createdByTaskId) return '';
  // SendMessage reaches only sessions on the machine it is sent from.
  if (tasks.find((t) => t.id === createdByTaskId)?.machine !== machine) return '';
  const sessionName = getSessionName(createdByTaskId);
  if (!sessionName) return '';
  return (
    `\n\n---\nThis task is Bifrost task ${taskId}. Bifrost's task tools act on it whenever taskId is omitted, ` +
    'so leave taskId out to act on this task.\n' +
    `Bifrost task ${createdByTaskId} is a different task: it created this one, and it is running and reachable. ` +
    `To report back, ask a question, or hand results over, use the built-in SendMessage tool with to: "${sessionName}". ` +
    'If that no longer reaches it, find_task on that id reports the name it is reachable by.'
  );
}

/** The task holding a working directory, which only one may do at a time. */
function activeTaskAt(worktreePath: string): Task | undefined {
  return tasks.find((t) => t.status !== 'archived' && t.worktreePath === worktreePath);
}

/** The repo a task runs against, with the worktree it was handed when it has one. */
export interface TaskTarget {
  repo: Repo;
  adopted?: { worktreePath: string; branch: string | null };
}

/**
 * The repo and worktree a caller's arguments name, adding a repo Bifrost does
 * not have yet. Arguments naming no repo, or a worktree another task holds,
 * throw here.
 */
export async function resolveTaskTarget(params: CreateTaskParams): Promise<TaskTarget> {
  const config = loadConfig();

  // A worktree names the repo it belongs to, so it settles the repo whatever
  // else the caller passed.
  const adopted = params.worktreePath ? await inspectWorktree(params.worktreePath) : undefined;
  const input = adopted?.repoPath ?? params.repoPath;

  let repo: Repo | undefined;
  if (input) {
    repo = matchRepo(config.repos, input) ?? undefined;
    if (!repo) {
      repo = await addRepo({ type: 'local', path: input });
      config.repos.push(repo);
      saveConfig(config);
    }
  } else {
    repo = config.repos.find((r: Repo) => r.id === params.repoId);
  }
  if (!repo) throw new Error(`Repo not found: ${params.repoId ?? input}`);

  if (params.machine) {
    getRemoteHost(params.machine);
    if (adopted || params.inPlace || params.prInfo) {
      throw new Error('A task on another machine starts from a fresh worktree there');
    }
  }

  if (adopted) {
    const conflict = activeTaskAt(adopted.worktreePath);
    if (conflict) {
      throw new Error(`An active task "${conflict.name}" already uses ${adopted.worktreePath}`);
    }
  }

  return { repo, adopted };
}

export async function createTaskCore(params: CreateTaskParams, target?: TaskTarget): Promise<Task> {
  if (params.multiRepoIds?.length) {
    return createMultiRepoTask(params);
  }

  const { repo, adopted } = target ?? (await resolveTaskTarget(params));
  if (params.machine) {
    const task = await createRemoteTask(params, repo, params.machine);
    if (isInstanceMachine(params.machine)) await handOverOrKeep(params.machine, task);
    return task;
  }

  // An adopted worktree's branch says what the work is.
  const name = params.branchName || params.name || adopted?.branch || generateTaskName();

  let worktreePath: string;
  let baseBranch = repo.defaultBranch;
  if (params.branch) {
    // Verify the requested branch/ref exists in the target repo before using it
    try {
      await execFile('git', ['rev-parse', '--verify', params.branch], { cwd: repo.path, timeout: 5000 });
      baseBranch = params.branch;
    } catch {
      console.warn(`[create-task] ref "${params.branch}" not found in ${repo.path}, using ${baseBranch}`);
    }
  }
  let inPlace = false;

  let taskBranch: string | undefined;
  if (adopted) {
    worktreePath = adopted.worktreePath;
    taskBranch = adopted.branch ?? undefined;
    // Archiving may not remove the repo's primary checkout, and a path can name
    // it as readily as any other worktree.
    inPlace = adopted.worktreePath === repo.path;
  } else if (params.inPlace) {
    const conflict = activeTaskAt(repo.path);
    if (conflict) {
      throw new Error(`An active task "${conflict.name}" already uses the main worktree for this repo`);
    }
    worktreePath = repo.path;
    const { stdout } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: repo.path, timeout: 5000 });
    baseBranch = stdout.trim();
    inPlace = true;
    taskBranch = baseBranch;
  } else {
    if (params.prInfo) {
      const created = await createWorktreeFromPr(repo.path, name, params.prInfo);
      worktreePath = created.worktreePath;
      taskBranch = created.branch;
    } else {
      const created = await createWorktree(repo.path, name, baseBranch, params.branchName);
      worktreePath = created.worktreePath;
      taskBranch = created.branch;
      // Record the ref the worktree actually forked from, so a diff compares
      // against that rather than a local branch that shares its name.
      baseBranch = created.baseRef;
    }
  }

  const taskId = randomUUID();
  const task: Task = {
    id: taskId,
    name,
    repoId: repo.id,
    baseBranch,
    ...(taskBranch ? { branch: taskBranch } : {}),
    worktreePath,
    sessionId: randomUUID(),
    status: 'running',
    hasUnread: false,
    createdAt: Date.now(),
    ...(inPlace && { inPlace: true }),
    ...(params.prompt ? { summary: params.prompt } : {}),
    ...(params.createdByTaskId ? { createdByTaskId: params.createdByTaskId } : {}),
  };
  startLocalSession(
    task,
    params.prompt ? params.prompt + creatorCoordinates(params.createdByTaskId, taskId) : undefined,
  );

  tasks.push(task);
  saveTasks(tasks);

  if (!_claudeCallbacks) throw new Error('Tasks not yet restored');
  startWatching(task.id, worktreePath, _claudeCallbacks);

  return task;
}

/** A first clone of a large repo runs to minutes. */
const CLONE_TIMEOUT_MS = 30 * 60_000;

/** The machine a task runs on, or null for this one and for a machine since removed from the settings. */
function remoteHostFor(task: Task): RemoteHost | null {
  if (!task.machine) return null;
  try {
    return getRemoteHost(task.machine);
  } catch (err) {
    console.warn(`[remote] task ${task.id}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Writes the session files of a task on this machine with the settings as
 * they are now, then joins its tmux session or starts it. A task without a
 * session id gets one, which Claude starts under.
 */
function startLocalSession(task: Task, prompt?: string): void {
  const config = loadConfig();
  let sessionId = task.sessionId;
  if (!sessionId) {
    sessionId = randomUUID();
    if (tasks.some((t) => t.id === task.id)) updateTask(task.id, { sessionId });
  }
  const launch = {
    taskId: task.id,
    name: task.name,
    permissionMode: config.permissionMode,
    agentTeams: config.agentTeams,
  };
  const machine = machineSession(config.permissionMode, config.remoteControlAtStartup === true);
  writeLocalSession({
    home: os.homedir(),
    taskId: task.id,
    worktreePath: task.worktreePath,
    sessionId,
    claudeArgs: [...claudeArgs(launch, machine.settings), ...machine.args],
    env: { ...claudeEnv(launch), ...machine.env },
    prompt,
  });
  attachLocalSession(task.id, { name: task.name, taskId: task.id });
}

/** Ends a task's session. On another machine the script also ends a tmux session no stream reads. */
export function stopTaskSession(task: Task): void {
  killSession(task.id);
  remoteHostFor(task)
    ?.exec(stopSessionScript(task.id))
    .catch((err) => console.warn(`[remote] could not stop ${task.id}: ${(err as Error).message}`));
}

async function localGitConfig(repoPath: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', ['config', key], { cwd: repoPath, timeout: 5000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates a task on another machine, in a worktree of a clone made there from
 * the repo's origin. Commits there carry the identity this repo commits with here.
 */
async function createRemoteTask(params: CreateTaskParams, repo: Repo, machine: string): Promise<Task> {
  const host = getRemoteHost(machine);
  const info = await host.connectReady();
  let url: string;
  try {
    ({ stdout: url } = await execFile('git', ['remote', 'get-url', 'origin'], { cwd: repo.path, timeout: 5000 }));
  } catch {
    throw new Error(`${repo.name} has no origin remote for ${machine} to clone from`);
  }
  const name = params.branchName || params.name || generateTaskName();
  const created = parseScriptOutput(
    await host.exec(
      worktreeScript({
        clonePath: remoteClonePath(repo),
        url: url.trim(),
        baseBranch: params.branch ?? repo.defaultBranch,
        branchName: params.branchName ?? slugify(name),
        slug: slugify(name),
        gitName: await localGitConfig(repo.path, 'user.name'),
        gitEmail: await localGitConfig(repo.path, 'user.email'),
      }),
      CLONE_TIMEOUT_MS,
    ),
  );
  if (!created.WORKTREE) throw new Error(`Could not create a worktree on ${machine}`);

  const taskId = randomUUID();
  const task: Task = {
    id: taskId,
    name,
    repoId: repo.id,
    machine,
    baseBranch: created.BASE,
    branch: created.BRANCH,
    worktreePath: created.WORKTREE,
    sessionId: randomUUID(),
    status: 'running',
    hasUnread: false,
    createdAt: Date.now(),
    ...(params.prompt ? { summary: params.prompt } : {}),
    ...(params.createdByTaskId ? { createdByTaskId: params.createdByTaskId } : {}),
  };
  const prompt = params.prompt
    ? params.prompt + creatorCoordinates(params.createdByTaskId, taskId, machine)
    : undefined;
  await writeRemoteSession(task, host, info, prompt);

  tasks.push(task);
  saveTasks(tasks);
  startRemoteSession(task);
  return task;
}

/** Writes the scripts the task's session starts from, with the settings as they are now. */
async function writeRemoteSession(task: Task, host: RemoteHost, info: RemoteInfo, prompt?: string): Promise<void> {
  // Kept on the task, since the instance it may be handed to learns it from the record.
  if (!task.sessionId) {
    task.sessionId = randomUUID();
    if (tasks.some((t) => t.id === task.id)) updateTask(task.id, { sessionId: task.sessionId });
  }
  const config = loadConfig();
  const launch = {
    taskId: task.id,
    name: task.name,
    permissionMode: config.permissionMode,
    agentTeams: config.agentTeams,
  };
  await host.exec(
    sessionSetupScript({
      home: info.home,
      taskId: task.id,
      worktreePath: task.worktreePath,
      sessionId: task.sessionId,
      claudeArgs: [
        ...claudeArgs(
          launch,
          remoteSessionSettings(config.permissionMode, localClaudeValue('remoteControlAtStartup') === true),
        ),
        ...(info.pluginDir ? ['--plugin-dir', info.pluginDir] : []),
      ],
      // The port is left to the file each connection rewrites, which follows Bifrost to a new port while tmux lives on.
      env: { ...claudeEnv(launch), BIFROST_MACHINE: task.machine ?? '' },
      prompt,
    }),
  );
}

function startRemoteSession(task: Task): void {
  if (!task.machine) throw new Error(`Task ${task.id} runs on this machine`);
  createRemoteSession(task.id, getRemoteHost(task.machine), {
    name: task.name,
    // Given up on, the session waits for its tab to be opened again, as after a restart.
    onGiveUp: () => pendingRestore.add(task.id),
  });
}

async function reopenRemoteTask(task: Task): Promise<Task> {
  const host = getRemoteHost(task.machine ?? '');
  const info = await host.connectReady();
  if (task.branch) await host.exec(restoreWorktreeScript(task.worktreePath, task.branch));
  await writeRemoteSession(task, host, info);
  startRemoteSession(task);
  return updateTask(task.id, { status: 'running', hasUnread: false, archivedAt: undefined });
}

/**
 * Moves a task from this machine to another, with its branch, its staged and
 * unstaged changes, and its conversation. The local worktree goes once the task
 * runs there, keeping its branch as archiving does, unless it holds untracked
 * files, which do not travel.
 */
export async function transferTaskCore(taskId: string, machine: string): Promise<Task> {
  const task = getTask(taskId);
  if (task.machine) throw new Error(`"${task.name}" already runs on ${task.machine}`);
  if (task.isExternal || task.inPlace) throw new Error('Only a task in a worktree of its own can be moved');
  const repo = loadConfig().repos.find((r: Repo) => r.id === task.repoId);
  if (!repo || repo.multiTaskId) throw new Error('Only a task in a single repo can be moved');
  const branch = headBranch(task.worktreePath);
  if (!branch) throw new Error('A detached HEAD has no branch to move');
  const baseRef = await resolveBaseRef(task.worktreePath, task.baseBranch);
  if (!baseRef) throw new Error(`Cannot find ${task.baseBranch} to move the branch against`);
  let url: string;
  try {
    ({ stdout: url } = await execFile('git', ['remote', 'get-url', 'origin'], { cwd: repo.path, timeout: 5000 }));
  } catch {
    throw new Error(`${repo.name} has no origin remote for ${machine} to clone from`);
  }
  const host = getRemoteHost(machine);
  const info = await host.connectReady();

  const slug = path.basename(task.worktreePath);
  const clonePath = remoteClonePath(repo);
  const remoteWorktree = `${info.home}/${clonePath}/.worktrees/${slug}`;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
  const transcript = task.sessionId
    ? path.join(projects, claudeProjectDir(task.worktreePath), `${task.sessionId}.jsonl`)
    : null;
  const dropDir = `.bifrost/transfer/${task.id}`;

  // The conversation is copied whole, so the session stops first and nothing writes to it meanwhile.
  const wasRunning = hasSession(taskId);
  cancelTaskRequests(taskId);
  stopWatching(taskId);
  killSession(taskId);
  const pack = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-transfer-'));
  let moved: Task;
  try {
    packTask(
      {
        worktreePath: task.worktreePath,
        baseRef,
        transcript: transcript && fs.existsSync(transcript) ? transcript : null,
        rewrites: [
          [task.worktreePath, remoteWorktree],
          [os.homedir(), info.home],
        ],
      },
      pack,
    );
    await host.upload(pack, dropDir);
    const out = parseScriptOutput(
      await host.exec(
        unpackScript({
          clonePath,
          url: url.trim(),
          baseBranch: baseRef.slice(baseRef.indexOf('/') + 1),
          branchName: branch,
          slug,
          gitName: await localGitConfig(repo.path, 'user.name'),
          gitEmail: await localGitConfig(repo.path, 'user.email'),
          dropDir,
          sessionId: task.sessionId ?? '',
        }),
        CLONE_TIMEOUT_MS,
      ),
    );
    if (!out.WORKTREE) throw new Error(`${machine} did not report the moved worktree`);
    moved = {
      ...task,
      machine,
      worktreePath: out.WORKTREE,
      branch: out.BRANCH,
      baseBranch: out.BASE,
      status: 'running',
    };
    await writeRemoteSession(moved, host, info);
  } catch (err) {
    // Nothing here has changed yet, so the task carries on where it was.
    if (wasRunning) restoreTaskSession(taskId);
    throw err;
  } finally {
    fs.rmSync(pack, { recursive: true, force: true });
  }

  const updated = updateTask(taskId, {
    machine,
    worktreePath: moved.worktreePath,
    branch: moved.branch,
    baseBranch: moved.baseBranch,
    status: 'running',
  });
  startRemoteSession(updated);
  emit(IPC_STREAM.TASK_UPDATED, updated);
  if (isInstanceMachine(machine)) await handOverOrKeep(machine, updated);

  const { stdout: untracked } = await execFile('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: task.worktreePath,
    timeout: 10000,
  });
  if (untracked.trim()) {
    const files = untracked.trim().split('\n');
    emit(
      IPC_STREAM.TOAST,
      `Kept ${task.worktreePath} here: ${files.length} untracked file${files.length === 1 ? '' : 's'} did not move`,
      8000,
    );
  } else {
    removeWorktree(repo.path, task.worktreePath).catch((err) =>
      console.error(`[transfer] could not remove ${task.worktreePath}:`, err),
    );
  }
  return updated;
}

/** The working diff of a task on another machine, or against its base for scope 'all'. */
export async function getRemoteDiff(task: Task, scope: 'working' | 'all' = 'working'): Promise<DiffResult> {
  const host = remoteHostFor(task);
  if (!host) return { worktreePath: task.worktreePath, diff: '' };
  const diff = await host.exec(diffScript(task.worktreePath, scope === 'all' ? task.baseBranch : undefined));
  return { worktreePath: task.worktreePath, diff };
}

/** Unreadable counts as clean, matching the local check, so a failed answer never blocks an archive. */
export async function isRemoteWorktreeDirty(task: Task): Promise<boolean> {
  try {
    return ((await remoteHostFor(task)?.exec(statusScript(task.worktreePath))) ?? '').trim().length > 0;
  } catch {
    return false;
  }
}

/** Check if a task needs session restoration (deferred on startup). */
export function isPendingRestore(taskId: string): boolean {
  return pendingRestore.has(taskId);
}

export function restoreTaskSession(taskId: string): void {
  pendingRestore.delete(taskId);
  const task = getTask(taskId);
  if (task.machine) {
    startRemoteSession(task);
    return;
  }
  startLocalSession(task);

  if (!_claudeCallbacks) throw new Error('Tasks not yet restored');
  startWatching(taskId, task.worktreePath, _claudeCallbacks, task.sessionId);
}

/** Bring an archived or stopped task back: worktree, session and watcher. */
export async function reopenTaskCore(taskId: string): Promise<Task> {
  await cleanups.get(taskId);
  const task = getTask(taskId);

  // Multi-repo tasks cannot be reopened (container is deleted on archive)
  const multiRepoGuardConfig = loadConfig();
  const multiRepoGuardRepo = multiRepoGuardConfig.repos.find((r: Repo) => r.id === task.repoId);
  if (multiRepoGuardRepo?.multiTaskId) {
    throw new Error('Multi-repo tasks cannot be reopened after archiving');
  }
  if (task.machine) return reopenRemoteTask(task);

  let worktreePath = task.worktreePath;
  let branch = task.branch;

  // Restore worktree from branch if it was removed during archive
  if (!fs.existsSync(worktreePath)) {
    if (task.isExternal || task.inPlace) {
      throw new Error(`Directory no longer exists: ${worktreePath}`);
    }
    const config = loadConfig();
    const repo = config.repos.find((r: Repo) => r.id === task.repoId);
    if (!repo) throw new Error(`Repo not found: ${task.repoId}`);
    worktreePath = await restoreWorktree(repo.path, task.name, task.branch);
  }

  // Re-detect current branch for in-place tasks (user may have switched)
  if (task.inPlace) {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: worktreePath });
      branch = stdout.trim();
    } catch {
      // ignore — keep existing branch
    }
  }

  // Check if stored sessionId is stale; if so, clear it so user can select a session
  let resumeSessionId = task.sessionId;
  if (resumeSessionId && isSessionStale(worktreePath, resumeSessionId)) {
    resumeSessionId = undefined;
    updateTask(taskId, { sessionId: undefined });
  }

  startLocalSession({ ...task, worktreePath, sessionId: resumeSessionId });

  if (!_claudeCallbacks) throw new Error('Tasks not yet restored');
  startWatching(taskId, worktreePath, _claudeCallbacks, resumeSessionId);

  return updateTask(taskId, {
    worktreePath,
    branch,
    status: 'running',
    hasUnread: false,
    archivedAt: undefined,
  });
}

/** Loads the task list, and brings back the sessions of the tasks that were running. */
export function restoreTasks(): void {
  const persisted = loadTasks();
  seedTurnBoundaries(persisted);
  const tasksToRestore = persisted.filter((t) => t.status === 'running');

  tasks = persisted.map((t) => (t.status === 'running' ? { ...t, status: 'stopped' as const } : t));

  setWorktreePathResolver((taskId) => getTask(taskId).worktreePath);

  _claudeCallbacks = {
    onSummary: (taskId: string, summary: string) => {
      try {
        updateTask(taskId, { summary });
        emit(IPC_STREAM.TASK_SUMMARY, taskId, summary);
      } catch {
        /* task may have been deleted */
      }
    },
  };

  const plan = planRestore(
    tasksToRestore,
    runningLocalSessions(),
    (task) => isSessionStale(task.worktreePath, task.sessionId),
    fs.existsSync,
  );
  const dropped = new Set(plan.dropSessionId);
  for (const id of [...plan.join, ...plan.defer]) {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) continue;
    tasks[idx] = {
      ...tasks[idx],
      status: 'running',
      hasUnread: false,
      ...(dropped.has(id) ? { sessionId: undefined } : {}),
    };
  }
  for (const id of plan.defer) pendingRestore.add(id);
  saveTasks(tasks);
  // Joined at once, so a session that ran on without Bifrost has its name and activity known.
  for (const id of plan.join) {
    try {
      restoreTaskSession(id);
    } catch (err) {
      console.error(`[ipc] Failed to rejoin task ${id}:`, err);
      updateTask(id, { status: 'error' });
    }
  }
}

/**
 * Takes over tasks another instance hands this one, keyed by id. A task already
 * here keeps the record it has, which may be newer than the one handed over. A
 * running task joins its session when that still runs, and otherwise waits for
 * its tab, as after a restart.
 */
export function importTasks(handed: Task[], repos: Repo[]): string[] {
  const config = loadConfig();
  const byId = new Map(config.repos.map((r) => [r.id, r]));
  for (const repo of repos) byId.set(repo.id, { ...byId.get(repo.id), ...repo });
  saveConfig({ ...config, repos: [...byId.values()] });

  for (const t of handed) {
    if (!tasks.some((x) => x.id === t.id)) tasks.push({ ...t, machine: undefined, unreachable: undefined });
  }
  saveTasks(tasks);

  const running = runningLocalSessions();
  for (const task of handed) {
    if (task.status !== 'running' || hasSession(task.id)) continue;
    if (!running.has(task.id)) {
      pendingRestore.add(task.id);
      continue;
    }
    try {
      restoreTaskSession(task.id);
    } catch (err) {
      console.error(`[tasks] Failed to join handed-over task ${task.id}:`, err);
      updateTask(task.id, { status: 'error' });
    }
  }
  return handed.map((t) => t.id);
}

/** Drops tasks that another instance now owns, leaving their worktrees and sessions as they are. */
export function forgetTasks(ids: string[]): void {
  const gone = new Set(ids);
  tasks = tasks.filter((t) => !gone.has(t.id));
  for (const id of ids) pendingRestore.delete(id);
  saveTasks(tasks);
}

/** A task that could not be handed over stays here, working as before, and the next start hands it over. */
async function handOverOrKeep(machine: string, task: Task): Promise<void> {
  await handOver(machine, [task]).catch((err) =>
    console.warn(`[instances] ${task.id} stays here for now: ${(err as Error).message}`),
  );
}

export function reorderTasks(taskIds: string[]): void {
  const idSet = new Set(taskIds);
  const reordered = taskIds.map((id) => tasks.find((t) => t.id === id)!).filter(Boolean);
  let ri = 0;
  tasks = tasks.map((t) => (idSet.has(t.id) ? reordered[ri++] : t));
  saveTasks(tasks);
}

export async function regenerateTaskTitleCore(
  taskId: string,
): Promise<{ task: Task; renamedBranch: string | null } | null> {
  const task = getTask(taskId);
  const generated = await generateTaskTitle(task.worktreePath, { sessionId: task.sessionId });
  if (!generated) return null;

  const renamedBranch = await renameWorktreeBranch(task, generated.branch);
  return {
    task: updateTask(taskId, {
      name: generated.title,
      summary: generated.description,
      ...(renamedBranch ? { branch: renamedBranch } : {}),
    }),
    renamedBranch,
  };
}

/** Takes a Claude session started outside Bifrost on as a task, in the directory it ran in. */
export async function resumeClaudeSessionCore(externalSessionId: string, cwd: string): Promise<Task> {
  const claudeCallbacks = _claudeCallbacks;
  if (!claudeCallbacks) throw new Error('Tasks not yet restored');
  if (!fs.existsSync(cwd)) {
    throw new Error(`Directory no longer exists: ${cwd}`);
  }

  const taskId = randomUUID();
  const name = path.basename(cwd);

  const config = loadConfig();
  const matchedRepo = config.repos.find((r: Repo) => cwd === r.path || cwd.startsWith(`${r.path}/`));
  let branch = '';
  if (matchedRepo) {
    try {
      const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
      branch = stdout.trim();
    } catch {
      // ignore
    }
  }

  const task: Task = {
    id: taskId,
    name,
    repoId: matchedRepo?.id ?? '',
    baseBranch: branch,
    branch,
    worktreePath: cwd,
    sessionId: externalSessionId,
    status: 'running',
    hasUnread: false,
    createdAt: Date.now(),
    isExternal: !matchedRepo,
  };
  startLocalSession(task);

  tasks.push(task);
  saveTasks(tasks);

  startWatching(taskId, cwd, claudeCallbacks, externalSessionId);

  return task;
}
