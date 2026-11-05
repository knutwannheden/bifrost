import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, IPC_STREAM, type IpcChannel } from '../shared/ipc-channels.ts';
import type { Repo, Task } from '../shared/types.ts';
import { loadConfig } from './config.ts';
import { BELL, type EventChannel, emit, emitFrom } from './event-sink.ts';

/** The calls whose first argument is the id of the task they act on. */
export const PER_TASK: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  IPC.CLOSE_TASK,
  IPC.STOP_TASK,
  IPC.ARCHIVE_TASK,
  IPC.IS_WORKTREE_DIRTY,
  IPC.REOPEN_TASK,
  IPC.CLEAR_INTERRUPTED,
  IPC.RENAME_TASK,
  IPC.REGENERATE_TASK_TITLE,
  IPC.DELETE_TASK,
  IPC.GET_DIFF,
  IPC.GET_FILE_STATUSES,
  IPC.GET_DIFF_STATS,
  IPC.GET_GIT_LOG,
  IPC.WALKTHROUGH_GET,
  IPC.WALKTHROUGH_GENERATE,
  IPC.WALKTHROUGH_DIFF,
  IPC.WALKTHROUGH_REMAP,
  IPC.GET_PR_URL,
  IPC.GET_LAST_CHANGED_FILE,
  IPC.GET_TOKEN_USAGE,
  IPC.CHANGE_FEED_LOAD,
  IPC.GET_SESSION_METRICS,
  IPC.SET_ACTIVE_TASK_ID,
  IPC.GET_LAST_ASSISTANT_MESSAGE,
  IPC.CURATOR_SET_OUTCOME,
  IPC.SEND_PROMPT,
]);

/** The calls whose first argument is the id of a request a session raised. */
export const BY_REQUEST: ReadonlySet<IpcChannel> = new Set<IpcChannel>([
  IPC.RESOLVE_PERMISSION,
  IPC.SCRAPE_PROMPT_RESPONSE,
]);

/** Calls after which the task is gone from its owner. */
const REMOVES: ReadonlySet<IpcChannel> = new Set<IpcChannel>([IPC.CLOSE_TASK, IPC.DELETE_TASK]);

const PEERS_DIR = path.join(os.homedir(), '.bifrost', 'peers');
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60_000;

interface Peer {
  name: string;
  connect: () => Promise<number>;
  /** Set while the event stream is open. */
  port: number | null;
  stream: AbortController | null;
  connecting: Promise<void> | null;
  /** Its own tasks, live while connected and the last list otherwise. */
  tasks: Task[];
  /** Its own repos, kept like its tasks. */
  repos: Repo[];
  /** Requests its sessions raised that are not answered yet. */
  requests: Set<string>;
  /** The next attempt to open a link that ended without being closed here. */
  retry: ReturnType<typeof setTimeout> | null;
}

const peers = new Map<string, Peer>();

/** connect resolves to a loopback port where that instance's API answers. */
export function registerPeer(name: string, connect: () => Promise<number>): void {
  // Registering again, as after a settings change, keeps a link that is up.
  const known = peers.get(name);
  if (known) {
    known.connect = connect;
    return;
  }
  peers.set(name, {
    name,
    connect,
    port: null,
    stream: null,
    connecting: null,
    tasks: readCache(`${name}.json`),
    repos: readCache(`${name}.repos.json`),
    requests: new Set(),
    retry: null,
  });
}

export function peerTasks(): Task[] {
  const here = loadConfig().repos;
  return [...peers.values()].flatMap((peer) =>
    peer.tasks.map((t) => ({ ...tagged(peer, t, here), ...(peer.port === null ? { unreachable: true } : {}) })),
  );
}

/** Subscribes to its events first, then fetches its tasks, so no change falls between the two. */
export function connectPeer(name: string): Promise<void> {
  const peer = peers.get(name);
  if (!peer) return Promise.reject(new Error(`No instance named ${name}`));
  if (peer.port !== null) return Promise.resolve();
  peer.connecting ??= open(peer).finally(() => {
    peer.connecting = null;
  });
  return peer.connecting;
}

/** Runs a call where the task or request it names lives. A failure there names the machine. */
export async function routeCall(
  channel: IpcChannel,
  args: unknown[],
  local: (...args: unknown[]) => unknown,
): Promise<unknown> {
  const peer = ownerOf(channel, args);
  if (!peer) return local(...args);
  try {
    await connectPeer(peer.name);
    const result = await call(peer, channel, args);
    noteResult(peer, channel, args[0] as string, result);
    return isTask(result) ? tagged(peer, result) : result;
  } catch (err) {
    const message = `${peer.name}: ${(err as Error).message}`;
    emit(IPC_STREAM.TOAST, message, 8000);
    throw new Error(message);
  }
}

/** The name of the peer that owns the task, if one does. */
export function peerOf(taskId: string): string | undefined {
  for (const peer of peers.values()) if (peer.tasks.some((t) => t.id === taskId)) return peer.name;
  return undefined;
}

/** Posts to one of the peer's routes, connecting first, and answers what it answers. */
export async function postToPeer(name: string, route: string, body: unknown): Promise<Record<string, unknown>> {
  await connectPeer(name);
  const peer = peers.get(name);
  if (!peer) throw new Error(`No instance named ${name}`);
  return post(peer, route, body);
}

/**
 * Answers an API request about another instance's task by posting it to that
 * instance, or null when the task it names is not a peer's.
 */
export async function forwardTaskRoute(
  route: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const id = body.taskId ?? body.callerTaskId;
  const peer = typeof id === 'string' ? peerOf(id) : undefined;
  if (!peer) return null;
  try {
    return await postToPeer(peer, route, body);
  } catch (err) {
    throw new Error(`${peer}: ${(err as Error).message}`);
  }
}

/** Lists the peer's tasks again, as after handing it some. */
export async function refreshPeer(name: string): Promise<void> {
  await connectPeer(name);
  const peer = peers.get(name);
  if (peer) await listTasks(peer);
}

/** Ends the link to the peer, which its next need opens again. */
export function disconnectPeer(name: string): void {
  const peer = peers.get(name);
  if (!peer) return;
  if (peer.retry) clearTimeout(peer.retry);
  peer.retry = null;
  peer.stream?.abort();
  peer.stream = null;
  peer.port = null;
}

export function closePeers(): void {
  for (const name of peers.keys()) disconnectPeer(name);
}

function ownerOf(channel: IpcChannel, args: unknown[]): Peer | undefined {
  const id = args[0];
  if (typeof id !== 'string') return undefined;
  for (const peer of peers.values()) {
    if (PER_TASK.has(channel) && peer.tasks.some((t) => t.id === id)) return peer;
    if (BY_REQUEST.has(channel) && peer.requests.has(id)) return peer;
  }
  return undefined;
}

async function open(peer: Peer): Promise<void> {
  const port = await peer.connect();
  const stream = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: stream.signal,
  });
  if (!res.ok || !res.body) throw new Error(`events answered ${res.status}`);
  peer.port = port;
  peer.stream = stream;
  void read(peer, res.body, stream);
  try {
    await listTasks(peer);
  } catch (err) {
    stream.abort();
    throw err;
  }
}

async function read(peer: Peer, body: ReadableStream<Uint8Array>, stream: AbortController): Promise<void> {
  const decoder = new TextDecoder();
  let rest = '';
  try {
    for await (const chunk of body) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) if (line) relay(peer, JSON.parse(line) as { channel: EventChannel; args: unknown[] });
    }
  } catch {
    /* an aborted or broken stream ends the link like a closed one */
  } finally {
    if (peer.stream === stream) {
      peer.stream = null;
      peer.port = null;
      emit(IPC_STREAM.TASKS_CHANGED);
      reconnect(peer, RETRY_FIRST_MS);
    }
  }
}

/** Tries to open the link until it is up or closed here, waiting twice as long after each failure, up to a minute. */
function reconnect(peer: Peer, delay: number): void {
  peer.retry = setTimeout(() => {
    peer.retry = null;
    connectPeer(peer.name).catch(() => reconnect(peer, Math.min(delay * 2, RETRY_MAX_MS)));
  }, delay);
  peer.retry.unref();
}

function relay(peer: Peer, event: { channel: EventChannel; args: unknown[] }): void {
  const { channel } = event;
  let { args } = event;
  if (channel === IPC_STREAM.TASK_CREATED || channel === IPC_STREAM.TASK_UPDATED) {
    const task = args[0] as Task;
    upsert(peer, task);
    args = [tagged(peer, task)];
  } else if (channel === IPC_STREAM.TASK_CLOSED) {
    const [id, archived] = args as [string, boolean];
    const task = peer.tasks.find((t) => t.id === id);
    if (task) upsert(peer, { ...task, status: archived ? 'archived' : 'stopped' });
  } else if (channel === IPC_STREAM.REPOS_CHANGED) {
    // The window keeps the repos here. The peer's serve only to match its tasks' repos to them.
    saveRepos(peer, args[0] as Repo[]);
    emit(IPC_STREAM.TASKS_CHANGED);
    return;
  } else if (channel === IPC_STREAM.PERMISSION_PROMPT) {
    peer.requests.add((args[0] as { requestId: string }).requestId);
  } else if (channel === IPC_STREAM.SCRAPE_PROMPT_REQUEST) {
    peer.requests.add(args[1] as string);
  } else if (channel === IPC_STREAM.CONSOLE_NOTIFICATION) {
    args = [args[0], args[1], peer.name];
  } else if (channel === BELL) {
    args = [`${args[0]} on ${peer.name}`];
  }
  emitFrom(peer.name, channel, ...args);
}

/** A call's answer is the owner's newest word on the task, since such calls raise no event. */
function noteResult(peer: Peer, channel: IpcChannel, id: string, result: unknown): void {
  if (BY_REQUEST.has(channel)) peer.requests.delete(id);
  else if (REMOVES.has(channel)) {
    peer.tasks = peer.tasks.filter((t) => t.id !== id);
    writeCache(peer);
  } else if (isTask(result) && result.id === id) upsert(peer, result);
}

/** The peer name a machine's instance gives the IDE's instance, which is also the machine value that means the IDE. */
export const IDE = 'ide';

/**
 * Names the machine a peer's task runs on. A task that names none runs on the peer's own.
 * Each instance gives a repo its own id, so the task takes the id of the repo here with the same GitHub slug.
 */
function tagged(peer: Peer, task: Task, here = loadConfig().repos): Task {
  const slug = peer.repos.find((r) => r.id === task.repoId)?.githubPath;
  const mine = slug ? here.find((r) => r.githubPath === slug) : undefined;
  return { ...task, machine: task.machine ?? peer.name, ...(mine && { repoId: mine.id }) };
}

function upsert(peer: Peer, task: Task): void {
  const at = peer.tasks.findIndex((t) => t.id === task.id);
  if (at >= 0) peer.tasks[at] = task;
  else peer.tasks.push(task);
  writeCache(peer);
}

function isTask(value: unknown): value is Task {
  return typeof value === 'object' && value !== null && 'id' in value && 'worktreePath' in value;
}

async function post(peer: Peer, route: string, body: unknown): Promise<Record<string, unknown>> {
  if (peer.port === null) throw new Error('not connected');
  const res = await fetch(`http://127.0.0.1:${peer.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error((answer.error as string | undefined) ?? `answered ${res.status}`);
  return answer;
}

async function call(peer: Peer, channel: IpcChannel, args: unknown[]): Promise<unknown> {
  return (await post(peer, '/call', { channel, args })).result;
}

async function listTasks(peer: Peer): Promise<void> {
  saveRepos(peer, (await call(peer, IPC.LIST_REPOS, [])) as Repo[]);
  peer.tasks = (await call(peer, IPC.LIST_TASKS, [])) as Task[];
  writeCache(peer);
  emit(IPC_STREAM.TASKS_CHANGED);
}

function saveRepos(peer: Peer, repos: Repo[]): void {
  peer.repos = repos;
  writeFile(`${peer.name}.repos.json`, repos);
}

function readCache<T>(file: string): T[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(PEERS_DIR, file), 'utf-8')) as T[];
  } catch {
    return [];
  }
}

function writeCache(peer: Peer): void {
  writeFile(`${peer.name}.json`, peer.tasks);
}

function writeFile(file: string, value: unknown): void {
  fs.mkdirSync(PEERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PEERS_DIR, file), JSON.stringify(value));
}
