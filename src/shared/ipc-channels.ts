import type {
  ActivityEntry,
  AddRepoParams,
  BifrostConfig,
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
  ARCHIVE_TASK: 'task:archive',
  REOPEN_TASK: 'task:reopen',
  RENAME_TASK: 'task:rename',
  DELETE_TASK: 'task:delete',
  LIST_TASKS: 'task:list',

  // Terminal sessions
  WRITE_TO_SESSION: 'session:write',
  RESIZE_SESSION: 'session:resize',

  // Diff
  GET_DIFF: 'diff:get',

  // Activity Log
  GET_ACTIVITY_LOG: 'activity:get-log',
  CLEAR_ACTIVITY_LOG: 'activity:clear',

  // IDE
  OPEN_IN_IDE: 'ide:open',

  // Dialog
  SELECT_DIRECTORY: 'dialog:select-directory',
} as const;

// Streaming channels (send/on)
export const IPC_STREAM = {
  SESSION_DATA: 'session:data',
  SESSION_EXIT: 'session:exit',
  NOTIFICATION: 'notification',
  ACTIVITY_ENTRY: 'activity:entry',
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
  archiveTask(taskId: string): Promise<Task>;
  reopenTask(taskId: string): Promise<Task>;
  renameTask(taskId: string, name: string): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  listTasks(): Promise<Task[]>;

  // Terminal
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

  // IDE
  openInIde(worktreePath: string): Promise<void>;

  // Dialog
  selectDirectory(): Promise<string | null>;

  // Notifications
  onNotification(callback: (title: string, body: string) => void): () => void;
}
