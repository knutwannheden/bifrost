import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONSOLE_PROMPT } from '../shared/default-prompts.ts';
import { IPC } from '../shared/ipc-channels.ts';
import { loadConfig } from './config.ts';
import { connectPeer, postToPeer } from './peers.ts';
import { getRemoteHost, machineSession } from './remote-host.ts';
import { attachLocalSession, createRemoteSession, detachSession, hasSession, killSession } from './session-manager.ts';
import { sessionDir, writeLocalSession } from './tmux-session.ts';

const CONSOLE_DIR = path.join(os.homedir(), '.bifrost', 'console');

/** Stable across restarts: the renderer attaches to it, the phone addresses it. */
export const CONSOLE_SESSION_ID = 'console';
export const CONSOLE_NAME = 'bifrost';

/** A crashing console must not respawn in a tight loop. */
const RESPAWN_DELAY_MS = 5_000;

let respawnTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Standing instructions belong on disk rather than in an opening message: the
 * console is addressed cold from a phone, and a turn spent on its own briefing
 * is a turn the user did not ask for.
 */
function writeInstructions(): void {
  fs.mkdirSync(CONSOLE_DIR, { recursive: true });
  const instructions = loadConfig().prompts?.console || DEFAULT_CONSOLE_PROMPT;
  fs.writeFileSync(path.join(CONSOLE_DIR, 'CLAUDE.md'), `${instructions}\n`, 'utf-8');
}

function spawn(sessionId: string = randomUUID()): void {
  writeInstructions();

  const machine = machineSession('skip-permissions', loadConfig().remoteControlAtStartup === true);
  // A console still running in tmux is joined, and a new one starts under sessionId.
  writeLocalSession({
    home: os.homedir(),
    taskId: CONSOLE_SESSION_ID,
    worktreePath: CONSOLE_DIR,
    sessionId,
    claudeArgs: [
      '--name',
      CONSOLE_NAME,
      '--dangerously-skip-permissions',
      ...(Object.keys(machine.settings).length ? ['--settings', JSON.stringify(machine.settings)] : []),
      ...machine.args,
    ],
    env: { BIFROST_CONTEXT: 'console', BIFROST_SESSION_NAME: CONSOLE_NAME, ...machine.env },
  });
  attachLocalSession(CONSOLE_SESSION_ID, {
    name: CONSOLE_NAME,
    onExit: () => {
      // Being reachable is the whole point, so an exit is temporary.
      if (respawnTimer) clearTimeout(respawnTimer);
      respawnTimer = setTimeout(spawn, RESPAWN_DELAY_MS);
    },
  });
}

export function initConsole(): void {
  spawn();
}

/** The session id to attach a terminal to, started if it is not up yet. */
export function getConsoleSession(): string {
  if (!hasSession(CONSOLE_SESSION_ID)) spawn();
  return CONSOLE_SESSION_ID;
}

/**
 * Start the conversation over, or with `resume` carry it on in a new process.
 * The console is a fixed address rather than a memory: days of orchestration
 * chatter are worth less than a clean window.
 */
export function resetConsole(resume = false): string {
  const sessionId = resume ? currentSessionId() : undefined;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  if (hasSession(CONSOLE_SESSION_ID)) killSession(CONSOLE_SESSION_ID);
  spawn(sessionId);
  return CONSOLE_SESSION_ID;
}

function currentSessionId(): string | undefined {
  try {
    return (
      fs.readFileSync(path.join(os.homedir(), sessionDir(CONSOLE_SESSION_ID), 'session-id'), 'utf-8').trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * A machine's own console, read here over ssh as one of its tasks is, under an
 * id of its own. Its instance, which runs it, is brought up first.
 */
export async function getMachineConsole(machine: string): Promise<string> {
  await connectPeer(machine);
  const id = `${CONSOLE_SESSION_ID}@${machine}`;
  if (!hasSession(id)) {
    createRemoteSession(id, getRemoteHost(machine), { name: CONSOLE_NAME, tmuxName: CONSOLE_SESSION_ID });
  }
  return id;
}

/** Starts a machine's console again, through its instance, and reads the new one. */
export async function resetMachineConsole(machine: string, resume = false): Promise<string> {
  // Let go of the old session first, so its end is not taken for the new one's.
  detachSession(`${CONSOLE_SESSION_ID}@${machine}`);
  await postToPeer(machine, '/call', { channel: IPC.CONSOLE_RESET, args: [null, resume] });
  return getMachineConsole(machine);
}
