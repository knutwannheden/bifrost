import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { DEFAULT_CONSOLE_PROMPT } from '../shared/default-prompts';
import { loadConfig } from './config';
import { hasSession, killSession, spawnSession } from './session-manager';

const CONSOLE_DIR = path.join(os.homedir(), '.bifrost', 'console');

/** Stable across restarts: the renderer attaches to it, the phone addresses it. */
export const CONSOLE_SESSION_ID = 'console';
const CONSOLE_NAME = 'bifrost';

/** A crashing console must not respawn in a tight loop. */
const RESPAWN_DELAY_MS = 5_000;

let mainWindow: BrowserWindow | null = null;
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

function spawn(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  writeInstructions();

  const extraEnv: Record<string, string> = { BIFROST_CONTEXT: 'console' };
  try {
    extraEnv.BIFROST_API_PORT = fs.readFileSync(path.join(os.homedir(), '.bifrost', 'api-port'), 'utf-8').trim();
  } catch {
    /* port file may not exist yet */
  }

  spawnSession(
    CONSOLE_SESSION_ID,
    'claude',
    ['--name', CONSOLE_NAME, '--dangerously-skip-permissions'],
    CONSOLE_DIR,
    mainWindow,
    {
      extraEnv,
      autoTrust: true,
      onBeforeExit: () => {
        // Being reachable is the whole point, so an exit is temporary.
        if (respawnTimer) clearTimeout(respawnTimer);
        respawnTimer = setTimeout(spawn, RESPAWN_DELAY_MS);
        return false;
      },
    },
  );
}

export function initConsole(window: BrowserWindow): void {
  mainWindow = window;
  spawn();
}

/** The session id to attach a terminal to, started if it is not up yet. */
export function getConsoleSession(): string {
  if (!hasSession(CONSOLE_SESSION_ID)) spawn();
  return CONSOLE_SESSION_ID;
}

/**
 * Start the conversation over. The console is a fixed address rather than a
 * memory: days of orchestration chatter are worth less than a clean window.
 */
export function resetConsole(): string {
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  if (hasSession(CONSOLE_SESSION_ID)) killSession(CONSOLE_SESSION_ID);
  spawn();
  return CONSOLE_SESSION_ID;
}
