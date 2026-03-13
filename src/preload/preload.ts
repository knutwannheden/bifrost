import { contextBridge, ipcRenderer } from 'electron';
import { BifrostAPI, IPC, IPC_STREAM } from '../shared/ipc-channels';

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
  getCurrentBranch: (repoId) => ipcRenderer.invoke(IPC.GET_CURRENT_BRANCH, repoId),
  getRecentRepos: () => ipcRenderer.invoke(IPC.GET_RECENT_REPOS),

  // Tasks
  createTask: (params) => ipcRenderer.invoke(IPC.CREATE_TASK, params),
  closeTask: (taskId) => ipcRenderer.invoke(IPC.CLOSE_TASK, taskId),
  stopTask: (taskId) => ipcRenderer.invoke(IPC.STOP_TASK, taskId),
  archiveTask: (taskId) => ipcRenderer.invoke(IPC.ARCHIVE_TASK, taskId),
  isWorktreeDirty: (taskId) => ipcRenderer.invoke(IPC.IS_WORKTREE_DIRTY, taskId),
  reopenTask: (taskId) => ipcRenderer.invoke(IPC.REOPEN_TASK, taskId),
  renameTask: (taskId, name) => ipcRenderer.invoke(IPC.RENAME_TASK, taskId, name),
  deleteTask: (taskId) => ipcRenderer.invoke(IPC.DELETE_TASK, taskId),
  listTasks: () => ipcRenderer.invoke(IPC.LIST_TASKS),
  reorderTasks: (taskIds) => ipcRenderer.invoke(IPC.REORDER_TASKS, taskIds),
  getSessionMtimes: () => ipcRenderer.invoke(IPC.GET_SESSION_MTIMES),

  // Terminal
  createDevTerminal: (taskId) => ipcRenderer.invoke(IPC.CREATE_DEV_TERMINAL, taskId),
  closeDevTerminal: (taskId) => ipcRenderer.invoke(IPC.CLOSE_DEV_TERMINAL, taskId),
  writeToSession: (sessionId, data) => ipcRenderer.invoke(IPC.WRITE_TO_SESSION, sessionId, data),
  resizeSession: (sessionId, cols, rows) => ipcRenderer.invoke(IPC.RESIZE_SESSION, sessionId, cols, rows),
  drainSessionBuffer: (sessionId) => ipcRenderer.invoke(IPC.DRAIN_SESSION_BUFFER, sessionId),
  onSessionData: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) => callback(sessionId, data);
    ipcRenderer.on(IPC_STREAM.SESSION_DATA, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.SESSION_DATA, handler);
  },
  onSessionExit: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, code: number) => callback(sessionId, code);
    ipcRenderer.on(IPC_STREAM.SESSION_EXIT, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.SESSION_EXIT, handler);
  },

  // Diff
  getDiff: (taskId, scope) => ipcRenderer.invoke(IPC.GET_DIFF, taskId, scope),
  getDiffStats: (taskId, scope) => ipcRenderer.invoke(IPC.GET_DIFF_STATS, taskId, scope),
  getFileStatuses: (taskId, scope) => ipcRenderer.invoke(IPC.GET_FILE_STATUSES, taskId, scope),
  getGitLog: (taskId) => ipcRenderer.invoke(IPC.GET_GIT_LOG, taskId),
  getPrUrl: (taskId) => ipcRenderer.invoke(IPC.GET_PR_URL, taskId),

  // Shell
  openUrl: (url) => ipcRenderer.invoke(IPC.OPEN_URL, url),

  // Activity Log
  getActivityLog: (taskId) => ipcRenderer.invoke(IPC.GET_ACTIVITY_LOG, taskId),
  clearActivityLog: (taskId) => ipcRenderer.invoke(IPC.CLEAR_ACTIVITY_LOG, taskId),
  onActivityEntry: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, entry: import('../shared/types').ActivityEntry) =>
      callback(entry);
    ipcRenderer.on(IPC_STREAM.ACTIVITY_ENTRY, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.ACTIVITY_ENTRY, handler);
  },

  // Token Usage
  getTokenUsage: (taskId) => ipcRenderer.invoke(IPC.GET_TOKEN_USAGE, taskId),

  // Terminal title
  setTerminalTitle: (taskId, title) => ipcRenderer.invoke(IPC.SET_TERMINAL_TITLE, taskId, title),

  // IDE
  openInIde: (worktreePath, filePath?, line?) => ipcRenderer.invoke(IPC.OPEN_IN_IDE, worktreePath, filePath, line),
  getLastChangedFile: (taskId) => ipcRenderer.invoke(IPC.GET_LAST_CHANGED_FILE, taskId),

  // Context capture
  captureContext: (params) => ipcRenderer.invoke(IPC.CAPTURE_CONTEXT, params),
  findTranscriptMatch: (worktreePath, searchText) =>
    ipcRenderer.invoke(IPC.FIND_TRANSCRIPT_MATCH, worktreePath, searchText),
  getApiPort: () => ipcRenderer.invoke(IPC.GET_API_PORT),

  // Claude sessions
  listClaudeSessions: () => ipcRenderer.invoke(IPC.LIST_CLAUDE_SESSIONS),
  resumeClaudeSession: (externalSessionId, cwd) =>
    ipcRenderer.invoke(IPC.RESUME_CLAUDE_SESSION, externalSessionId, cwd),

  // Review
  runReview: (taskId, scope, instructions) => ipcRenderer.invoke(IPC.RUN_REVIEW, taskId, scope, instructions),
  cancelReview: (taskId) => ipcRenderer.invoke(IPC.CANCEL_REVIEW, taskId),
  saveReview: (taskId, reviewId, content) => ipcRenderer.invoke(IPC.SAVE_REVIEW, taskId, reviewId, content),
  loadReview: (taskId, reviewId) => ipcRenderer.invoke(IPC.LOAD_REVIEW, taskId, reviewId),
  resumeReview: (taskId, reviewId) => ipcRenderer.invoke(IPC.RESUME_REVIEW, taskId, reviewId),
  listReviews: (taskId) => ipcRenderer.invoke(IPC.LIST_REVIEWS, taskId),
  deleteReview: (taskId, reviewId) => ipcRenderer.invoke(IPC.DELETE_REVIEW, taskId, reviewId),
  closeReviewSession: (taskId) => ipcRenderer.invoke(IPC.CLOSE_REVIEW_SESSION, taskId),
  onReviewProgress: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, reviewId: string, content: string) =>
      callback(taskId, reviewId, content);
    ipcRenderer.on(IPC_STREAM.REVIEW_PROGRESS, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.REVIEW_PROGRESS, handler);
  },
  onReviewSession: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, reviewId: string, sessionId: string) =>
      callback(taskId, reviewId, sessionId);
    ipcRenderer.on(IPC_STREAM.REVIEW_SESSION, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.REVIEW_SESSION, handler);
  },
  onReviewActivity: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, reviewId: string, activity: string) =>
      callback(taskId, reviewId, activity);
    ipcRenderer.on(IPC_STREAM.REVIEW_ACTIVITY, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.REVIEW_ACTIVITY, handler);
  },

  // Integration
  checkIntegration: () => ipcRenderer.invoke(IPC.CHECK_INTEGRATION),
  installIntegration: () => ipcRenderer.invoke(IPC.INSTALL_INTEGRATION),
  checkPrerequisites: () => ipcRenderer.invoke(IPC.CHECK_PREREQUISITES),
  installOllamaModel: (model) => ipcRenderer.invoke(IPC.INSTALL_OLLAMA_MODEL, model),

  // Dialog
  selectDirectory: () => ipcRenderer.invoke(IPC.SELECT_DIRECTORY),

  // Clipboard
  readClipboard: () => ipcRenderer.invoke(IPC.READ_CLIPBOARD),

  // PR
  fetchPrInfo: (repoId, prNumber, ghRepo?) => ipcRenderer.invoke(IPC.FETCH_PR_INFO, repoId, prNumber, ghRepo),
  matchRepoForPr: (owner, repo) => ipcRenderer.invoke(IPC.MATCH_REPO_FOR_PR, owner, repo),
  checkGhAvailable: () => ipcRenderer.invoke(IPC.CHECK_GH_AVAILABLE),

  // Task events
  onTaskSummary: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, summary: string) => callback(taskId, summary);
    ipcRenderer.on(IPC_STREAM.TASK_SUMMARY, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.TASK_SUMMARY, handler);
  },
  onTaskCreated: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, task: import('../shared/types').Task) => callback(task);
    ipcRenderer.on(IPC_STREAM.TASK_CREATED, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.TASK_CREATED, handler);
  },
  onTaskClosed: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, archived: boolean) =>
      callback(taskId, archived);
    ipcRenderer.on(IPC_STREAM.TASK_CLOSED, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.TASK_CLOSED, handler);
  },

  // Notifications
  setActiveTaskId: (taskId) => ipcRenderer.invoke(IPC.SET_ACTIVE_TASK_ID, taskId),
  getLastAssistantMessage: (taskId) => ipcRenderer.invoke(IPC.GET_LAST_ASSISTANT_MESSAGE, taskId),

  // Hook notifications
  onHookNotification: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      taskId: string,
      taskName: string,
      message: string,
      title: string,
      notificationType: string,
    ) => callback(taskId, taskName, message, title, notificationType);
    ipcRenderer.on(IPC_STREAM.HOOK_NOTIFICATION, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.HOOK_NOTIFICATION, handler);
  },

  // Permission prompts
  onPermissionPrompt: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, request: import('../shared/types').PermissionPromptData) =>
      callback(request);
    ipcRenderer.on(IPC_STREAM.PERMISSION_PROMPT, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.PERMISSION_PROMPT, handler);
  },
  resolvePermission: (requestId, decision) => ipcRenderer.invoke(IPC.RESOLVE_PERMISSION, requestId, decision),

  // Notes
  listNotes: (repoId) => ipcRenderer.invoke(IPC.NOTE_LIST, repoId),
  createNote: (repoId, text) => ipcRenderer.invoke(IPC.NOTE_CREATE, repoId, text),
  updateNote: (repoId, noteId, updates) => ipcRenderer.invoke(IPC.NOTE_UPDATE, repoId, noteId, updates),
  deleteNote: (repoId, noteId) => ipcRenderer.invoke(IPC.NOTE_DELETE, repoId, noteId),

  // Stats
  getStats: (since?: number) => ipcRenderer.invoke(IPC.GET_STATS, since),
  onStatsUpdate: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: import('../shared/types').StatsData) => callback(data);
    ipcRenderer.on(IPC_STREAM.STATS_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.STATS_UPDATE, handler);
  },

  // Supervisor
  getSupervisorState: () => ipcRenderer.invoke(IPC.SUPERVISOR_GET_STATE),
  startSupervisor: () => ipcRenderer.invoke(IPC.SUPERVISOR_START),
  stopSupervisor: () => ipcRenderer.invoke(IPC.SUPERVISOR_STOP),
  setSupervisorConcurrency: (n) => ipcRenderer.invoke(IPC.SUPERVISOR_SET_CONCURRENCY, n),
  pauseSupervisorItem: (itemId) => ipcRenderer.invoke(IPC.SUPERVISOR_PAUSE_ITEM, itemId),
  resumeSupervisorItem: (itemId) => ipcRenderer.invoke(IPC.SUPERVISOR_RESUME_ITEM, itemId),
  openSupervisorItem: (itemId) => ipcRenderer.invoke(IPC.SUPERVISOR_OPEN_ITEM, itemId),
  removeSupervisorItem: (itemId) => ipcRenderer.invoke(IPC.SUPERVISOR_REMOVE_ITEM, itemId),
  onSupervisorUpdate: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, supervisorState: import('../shared/types').SupervisorState) =>
      callback(supervisorState);
    ipcRenderer.on(IPC_STREAM.SUPERVISOR_UPDATE, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.SUPERVISOR_UPDATE, handler);
  },

  // Slack
  startSlackOAuth: () => ipcRenderer.invoke(IPC.SLACK_START_OAUTH),
  disconnectSlack: () => ipcRenderer.invoke(IPC.SLACK_DISCONNECT),
  onSlackReaction: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      channelId: string,
      messageTs: string,
      messageUrl: string,
      messagePreview: string,
    ) => callback(channelId, messageTs, messageUrl, messagePreview);
    ipcRenderer.on(IPC_STREAM.SLACK_REACTION, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.SLACK_REACTION, handler);
  },

  // Triage
  startTriage: (prompt) => ipcRenderer.invoke(IPC.START_TRIAGE, prompt),
  cancelTriage: (triageId) => ipcRenderer.invoke(IPC.CANCEL_TRIAGE, triageId),
  listTriages: () => ipcRenderer.invoke(IPC.LIST_TRIAGES),
  deleteTriage: (triageId) => ipcRenderer.invoke(IPC.DELETE_TRIAGE, triageId),
  onTriageActivity: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, triageId: string, activity: string) =>
      callback(triageId, activity);
    ipcRenderer.on(IPC_STREAM.TRIAGE_ACTIVITY, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.TRIAGE_ACTIVITY, handler);
  },
  onTriageWaiting: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, triageId: string, message: string) =>
      callback(triageId, message);
    ipcRenderer.on(IPC_STREAM.TRIAGE_WAITING, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.TRIAGE_WAITING, handler);
  },

  // Claude activity
  onClaudeActive: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, active: boolean) => callback(taskId, active);
    ipcRenderer.on(IPC_STREAM.CLAUDE_ACTIVE, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.CLAUDE_ACTIVE, handler);
  },

  // Prompt sender
  sendPrompt: (taskId, text, mode) => ipcRenderer.invoke(IPC.SEND_PROMPT, taskId, text, mode),
  onScrapePromptRequest: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string, requestId: string) =>
      callback(taskId, requestId);
    ipcRenderer.on(IPC_STREAM.SCRAPE_PROMPT_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.SCRAPE_PROMPT_REQUEST, handler);
  },
  scrapePromptResponse: (requestId, text) => ipcRenderer.invoke(IPC.SCRAPE_PROMPT_RESPONSE, requestId, text),
  onTerminalUnlock: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, taskId: string) => callback(taskId);
    ipcRenderer.on(IPC_STREAM.TERMINAL_UNLOCK, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.TERMINAL_UNLOCK, handler);
  },

  // Menu actions
  onMenuAction: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => callback(action);
    ipcRenderer.on(IPC_STREAM.MENU_ACTION, handler);
    return () => ipcRenderer.removeListener(IPC_STREAM.MENU_ACTION, handler);
  },
};

contextBridge.exposeInMainWorld('bifrost', api);
