import { execFile as execFileCb } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';

const execFile = promisify(execFileCb);

import { IPC, IPC_STREAM, type IpcChannel } from '../shared/ipc-channels';
import type { BifrostConfig, CaptureContextParams } from '../shared/types';
import { applyClaudeConfigDir } from './claude-paths';
import { loadConfig, mergeRendererConfig, saveConfig } from './config';
import { CONSOLE_SESSION_ID } from './console-service';
import { store as storeContext } from './context-store';
import { noteWindowBlur, noteWindowFocus } from './disk-reclaim-service';
import { emit } from './event-sink';
import { openFileInIde, openInIde, remoteHost } from './ide-launcher';
import { linkInstances } from './instance-link';
import { calls } from './ipc-calls';
import { peerTasks, routeCall } from './peers';
import { getRemoteHost, storePasteHere } from './remote-host';
import { devTerminalCount } from './session-manager';
import { disconnectSlack, restartPolling, startOAuth } from './slack-service';
import { getTasks } from './task-service';
import { openTerminal } from './terminal-launcher';

const allTasks = () => [...getTasks(), ...peerTasks()];
const hostOf = (filePath: string) => remoteHost(filePath, allTasks(), loadConfig().machines ?? []);
/** The machine a session runs on when it is another one: its task's, or the one a console's id names after the @. */
const sessionMachine = (sessionId: string) => {
  const [name, machine] = sessionId.split('@');
  return name === CONSOLE_SESSION_ID && machine ? machine : allTasks().find((t) => t.id === sessionId)?.machine;
};

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  for (const [channel, call] of Object.entries(calls) as Array<[IpcChannel, (...args: unknown[]) => unknown]>) {
    if (channel === IPC.WRITE_TO_SESSION) ipcMain.on(channel, (_event, ...args) => call(...args));
    else if (channel === IPC.LIST_TASKS) ipcMain.handle(channel, () => [...getTasks(), ...peerTasks()]);
    else ipcMain.handle(channel, (_event, ...args) => routeCall(channel, args, call));
  }
  ipcMain.handle(IPC.SAVE_CONFIG, (_event, config: BifrostConfig) => {
    const current = loadConfig();
    const merged = mergeRendererConfig(config, current);
    saveConfig(merged);
    // Applied before linkInstances, which sends it to the instances on other machines.
    if (merged.claudeConfigDir !== current.claudeConfigDir) applyClaudeConfigDir(merged.claudeConfigDir);
    restartPolling(mainWindow);
    // Turning "Run Bifrost there" on is when a machine's tasks move to its instance.
    linkInstances();
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
        const worktree = allTasks().find(
          (t) => t.worktreePath && filePath.startsWith(`${t.worktreePath}/`),
        )?.worktreePath;
        return openFileInIde(filePath, line, worktree, hostOf(filePath));
      } catch {
        return;
      }
    }
    if (!/^https?:\/\//i.test(url)) return;
    return shell.openExternal(url);
  });

  // The script detaches the restart itself, which asks this process to quit, and returns at once.
  ipcMain.handle(IPC.RESTART_APP, async (_event, force: boolean) => {
    const devTerminals = devTerminalCount();
    if (devTerminals > 0 && !force) return { restarting: false, devTerminals };
    const script = path.join(process.cwd(), 'scripts', 'restart-bifrost.sh');
    try {
      await execFile('bash', [script], { cwd: process.cwd() });
      return { restarting: true, devTerminals };
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr?.trim();
      return { restarting: false, devTerminals, error: stderr || (err as Error).message };
    }
  });

  ipcMain.handle(IPC.OPEN_IN_TERMINAL, async (_event, dirPath: string) => {
    if (!(await openTerminal(loadConfig().terminal, dirPath))) shell.showItemInFolder(dirPath);
  });

  // IDE
  ipcMain.handle(IPC.OPEN_IN_IDE, (_event, worktreePath: string, filePath?: string, line?: number) =>
    openInIde(worktreePath, undefined, filePath, line, hostOf(worktreePath)).catch((err: Error) => {
      emit(IPC_STREAM.TOAST, err.message, 5000);
    }),
  );

  // An image reaches a session as a file on its machine, and the window pastes its path at the prompt.
  ipcMain.handle(IPC.PASTE_IMAGE, async (_event, sessionId: string, remoteOnly: boolean) => {
    const machine = sessionMachine(sessionId);
    if (remoteOnly && !machine) return null;
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    const name = `${randomUUID()}.png`;
    try {
      return await (machine
        ? getRemoteHost(machine).storePaste(image.toPNG(), name)
        : storePasteHere(image.toPNG(), name));
    } catch (err) {
      emit(IPC_STREAM.TOAST, `Could not paste the image: ${(err as Error).message}`, 5000);
      throw err;
    }
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

  mainWindow.on('blur', noteWindowBlur);
  mainWindow.on('focus', noteWindowFocus);

  // Slack
  ipcMain.handle(IPC.SLACK_START_OAUTH, () => startOAuth(mainWindow));
  ipcMain.handle(IPC.SLACK_DISCONNECT, () => disconnectSlack());
}
