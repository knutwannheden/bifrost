import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC, IPC_STREAM, type IpcChannel } from '../shared/ipc-channels.ts';
import type { Task } from '../shared/types.ts';
import { type EventChannel, emit, emitFrom } from './event-sink.ts';

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

interface Peer {
  name: string;
  connect: () => Promise<number>;
  /** Set while the event stream is open. */
  port: number | null;
  stream: AbortController | null;
  connecting: Promise<void> | null;
  /** Its own tasks, live while connected and the last list otherwise. */
  tasks: Task[];
  /** Requests its sessions raised that are not answered yet. */
  requests: Set<string>;
}

const peers = new Map<string, Peer>();

/** connect resolves to a loopback port where that instance's API answers. */
export function registerPeer(name: string, connect: () => Promise<number>): void {
  peers.set(name, {
    name,
    connect,
    port: null,
    stream: null,
    connecting: null,
    tasks: readCache(name),
    requests: new Set(),
  });
}

export function peerTasks(): Task[] {
  return [...peers.values()].flatMap((peer) =>
    peer.tasks.map((t) => ({ ...t, machine: peer.name, ...(peer.port === null ? { unreachable: true } : {}) })),
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
    const result = await post(peer, '/call', { channel, args });
    noteResult(peer, channel, args[0] as string, result);
    return isTask(result) ? { ...result, machine: peer.name } : result;
  } catch (err) {
    throw new Error(`${peer.name}: ${(err as Error).message}`);
  }
}

export function closePeers(): void {
  for (const peer of peers.values()) {
    peer.stream?.abort();
    peer.stream = null;
    peer.port = null;
  }
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
    peer.tasks = (await post(peer, '/call', { channel: IPC.LIST_TASKS, args: [] })) as Task[];
  } catch (err) {
    stream.abort();
    throw err;
  }
  writeCache(peer);
  emit(IPC_STREAM.TASKS_CHANGED);
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
    }
  }
}

function relay(peer: Peer, event: { channel: EventChannel; args: unknown[] }): void {
  const { channel } = event;
  let { args } = event;
  if (channel === IPC_STREAM.TASK_CREATED || channel === IPC_STREAM.TASK_UPDATED) {
    const task = args[0] as Task;
    upsert(peer, task);
    args = [{ ...task, machine: peer.name }];
  } else if (channel === IPC_STREAM.TASK_CLOSED) {
    const [id, archived] = args as [string, boolean];
    const task = peer.tasks.find((t) => t.id === id);
    if (task) upsert(peer, { ...task, status: archived ? 'archived' : 'stopped' });
  } else if (channel === IPC_STREAM.PERMISSION_PROMPT) {
    peer.requests.add((args[0] as { requestId: string }).requestId);
  } else if (channel === IPC_STREAM.SCRAPE_PROMPT_REQUEST) {
    peer.requests.add(args[1] as string);
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

function upsert(peer: Peer, task: Task): void {
  const at = peer.tasks.findIndex((t) => t.id === task.id);
  if (at >= 0) peer.tasks[at] = task;
  else peer.tasks.push(task);
  writeCache(peer);
}

function isTask(value: unknown): value is Task {
  return typeof value === 'object' && value !== null && 'id' in value && 'worktreePath' in value;
}

async function post(peer: Peer, route: string, body: unknown): Promise<unknown> {
  if (peer.port === null) throw new Error('not connected');
  const res = await fetch(`http://127.0.0.1:${peer.port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const answer = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok) throw new Error(answer.error ?? `answered ${res.status}`);
  return answer.result;
}

function readCache(name: string): Task[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(PEERS_DIR, `${name}.json`), 'utf-8')) as Task[];
  } catch {
    return [];
  }
}

function writeCache(peer: Peer): void {
  fs.mkdirSync(PEERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PEERS_DIR, `${peer.name}.json`), JSON.stringify(peer.tasks));
}
