import { contextBridge, ipcRenderer } from 'electron';
import { IPC, IPC_STREAM, BifrostAPI } from '../shared/ipc-channels';

const api: BifrostAPI = {
  // Config
  loadConfig: () => ipcRenderer.invoke(IPC.LOAD_CONFIG),
  saveConfig: (config) => ipcRenderer.invoke(IPC.SAVE_CONFIG, config),
  setIde: (ide) => ipcRenderer.invoke(IPC.SET_IDE, ide),

  // Repos
  addRepo: (params) => ipcRenderer.invoke(IPC.ADD_REPO, params),
  removeRepo: (repoId) => ipcRenderer.invoke(IPC.REMOVE_REPO, repoId),
  listRepos: () => ipcRenderer.invoke(IPC.LIST_REPOS),
  getRepoBranches: (repoId) => ipcRenderer.invoke(IPC.GET_REPO_BRANCHES, repoId),

  // Tasks
  createTask: (params) => ipcRenderer.invoke(IPC.CREATE_TASK, params),
  closeTask: (taskId) => ipcRenderer.invoke(IPC.CLOSE_TASK, taskId),
  stopTask: (taskId) => ipcRenderer.invoke(IPC.STOP_TASK, taskId),
  archiveTask: (taskId) => ipcRenderer.invoke(IPC.ARCHIVE_TASK, taskId),
  reopenTask: (taskId) => ipcRenderer.invoke(IPC.REOPEN_TASK, taskId),
  renameTask: (taskId, name) => ipcRenderer.invoke(IPC.RENAME_TASK, taskId, name),
  deleteTask: (taskId) => ipcRenderer.invoke(IPC.DELETE_TASK, taskId),
  listTasks: () => ipcRenderer.invoke(IPC.LIST_TASKS),

  // Terminal
  createDevTerminal: (taskId) => ipcRenderer.invoke(IPC.CREATE_DEV_TERMINAL, taskId),
  closeDevTerminal: (taskId) => ipcRenderer.invoke(IPC.CLOSE_DEV_TERMINAL, taskId),
  writeToSession: (sessionId, data) =>
    ipcRenderer.invoke(IPC.WRITE_TO_SESSION, sessionId, data),
  resizeSession: (sessionId, cols, rows) =>
    ipcRenderer.invoke(IPC.RESIZE_SESSION, sessionId, cols, rows),
  onSessionData: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) =>
      callback(sessionId, data);
    ipcRenderer.on(IPC_STREAM.SESSION_DATA, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.SESSION_DATA, handler);
  },
  onSessionExit: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, code: number) =>
      callback(sessionId, code);
    ipcRenderer.on(IPC_STREAM.SESSION_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.SESSION_EXIT, handler);
  },

  // Diff
  getDiff: (taskId) => ipcRenderer.invoke(IPC.GET_DIFF, taskId),

  // Activity Log
  getActivityLog: (taskId) => ipcRenderer.invoke(IPC.GET_ACTIVITY_LOG, taskId),
  clearActivityLog: (taskId) => ipcRenderer.invoke(IPC.CLEAR_ACTIVITY_LOG, taskId),
  onActivityEntry: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: import('../shared/types').ActivityEntry) =>
      callback(entry);
    ipcRenderer.on(IPC_STREAM.ACTIVITY_ENTRY, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.ACTIVITY_ENTRY, handler);
  },

  // Terminal title
  setTerminalTitle: (taskId, title) => ipcRenderer.invoke(IPC.SET_TERMINAL_TITLE, taskId, title),

  // IDE
  openInIde: (worktreePath) => ipcRenderer.invoke(IPC.OPEN_IN_IDE, worktreePath),

  // Context capture
  captureContext: (params) =>
    ipcRenderer.invoke(IPC.CAPTURE_CONTEXT, params),
  findTranscriptMatch: (worktreePath, searchText) =>
    ipcRenderer.invoke(IPC.FIND_TRANSCRIPT_MATCH, worktreePath, searchText),
  getApiPort: () => ipcRenderer.invoke(IPC.GET_API_PORT),

  // Dialog
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),

  // Notifications
  onNotification: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, title: string, body: string) =>
      callback(title, body);
    ipcRenderer.on(IPC_STREAM.NOTIFICATION, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.NOTIFICATION, handler);
  },
};

contextBridge.exposeInMainWorld('bifrost', api);
