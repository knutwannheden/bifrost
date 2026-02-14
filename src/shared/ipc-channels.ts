import type {
  ActivityEntry,
  AddRepoParams,
  BifrostConfig,
  CaptureContextParams,
  ClaudeSession,
  CreateTaskParams,
  DiffResult,
  Repo,
  Task,
} from './types';

// Request-response channels (invoke/handle)
export const IPC = {
  // Config
  LOAD_CONFIG: 'config:load',
  SAVE_CONFIG: 'config:save',
  SET_IDE: 'config:set-ide',

  // Repos
  ADD_REPO: 'repo:add',
  REMOVE_REPO: 'repo:remove',
  LIST_REPOS: 'repo:list',
  GET_REPO_BRANCHES: 'repo:branches',

  // Tasks
  CREATE_TASK: 'task:create',
  CLOSE_TASK: 'task:close',
  STOP_TASK: 'task:stop',
  ARCHIVE_TASK: 'task:archive',
  REOPEN_TASK: 'task:reopen',
  RENAME_TASK: 'task:rename',
  DELETE_TASK: 'task:delete',
  LIST_TASKS: 'task:list',

  // Terminal sessions
  CREATE_DEV_TERMINAL: 'session:create-dev-terminal',
  CLOSE_DEV_TERMINAL: 'session:close-dev-terminal',
  WRITE_TO_SESSION: 'session:write',
  RESIZE_SESSION: 'session:resize',

  // Diff
  GET_DIFF: 'diff:get',

  // Activity Log
  GET_ACTIVITY_LOG: 'activity:get-log',
  CLEAR_ACTIVITY_LOG: 'activity:clear',

  // IDE
  OPEN_IN_IDE: 'ide:open',

  // Terminal title
  SET_TERMINAL_TITLE: 'task:set-terminal-title',

  // Context capture
  CAPTURE_CONTEXT: 'context:capture',
  FIND_TRANSCRIPT_MATCH: 'context:find-transcript-match',
  GET_API_PORT: 'api:get-port',

  // Claude sessions
  LIST_CLAUDE_SESSIONS: 'claude:list-sessions',
  RESUME_CLAUDE_SESSION: 'claude:resume-session',

  // Dialog
  SELECT_DIRECTORY: 'dialog:select-directory',
} as const;

// Streaming channels (send/on)
export const IPC_STREAM = {
  SESSION_DATA: 'session:data',
  SESSION_EXIT: 'session:exit',
  NOTIFICATION: 'notification',
  ACTIVITY_ENTRY: 'activity:entry',
  MENU_ACTION: 'menu:action',
} as const;

// Typed API exposed via contextBridge as window.bifrost
export interface BifrostAPI {
  // Config
  loadConfig(): Promise<BifrostConfig>;
  saveConfig(config: BifrostConfig): Promise<void>;
  setIde(ide: 'code' | 'idea'): Promise<void>;

  // Repos
  addRepo(params: AddRepoParams): Promise<Repo>;
  removeRepo(repoId: string): Promise<void>;
  listRepos(): Promise<Repo[]>;
  getRepoBranches(repoId: string): Promise<string[]>;

  // Tasks
  createTask(params: CreateTaskParams): Promise<Task>;
  closeTask(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<Task>;
  archiveTask(taskId: string): Promise<Task>;
  reopenTask(taskId: string): Promise<Task>;
  renameTask(taskId: string, name: string): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  listTasks(): Promise<Task[]>;

  // Terminal
  createDevTerminal(taskId: string): Promise<string>;
  closeDevTerminal(taskId: string): Promise<void>;
  writeToSession(sessionId: string, data: string): Promise<void>;
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>;
  onSessionData(callback: (sessionId: string, data: string) => void): () => void;
  onSessionExit(callback: (sessionId: string, code: number) => void): () => void;

  // Diff
  getDiff(taskId: string): Promise<DiffResult>;

  // Activity Log
  getActivityLog(taskId: string): Promise<ActivityEntry[]>;
  clearActivityLog(taskId: string): Promise<void>;
  onActivityEntry(callback: (entry: ActivityEntry) => void): () => void;

  // Terminal title
  setTerminalTitle(taskId: string, title: string): Promise<void>;

  // IDE
  openInIde(worktreePath: string): Promise<void>;

  // Context capture
  captureContext(params: CaptureContextParams): Promise<number>;
  findTranscriptMatch(worktreePath: string, searchText: string): Promise<{ jsonlPath: string; lineNumber: number; uuid: string } | null>;
  getApiPort(): Promise<number | null>;

  // Claude sessions
  listClaudeSessions(): Promise<ClaudeSession[]>;
  resumeClaudeSession(claudeSessionId: string, cwd: string): Promise<Task>;

  // Dialog
  selectDirectory(): Promise<string | null>;

  // Notifications
  onNotification(callback: (title: string, body: string) => void): () => void;

  // Menu actions
  onMenuAction(callback: (action: string) => void): () => void;
}
