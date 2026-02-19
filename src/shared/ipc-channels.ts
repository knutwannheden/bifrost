import type {
  ActivityEntry,
  AddRepoParams,
  BifrostConfig,
  CaptureContextParams,
  ClaudeSession,
  CreateTaskParams,
  DiffResult,
  DiffStats,
  GitLogEntry,
  PermissionDecision,
  PermissionPromptData,
  PrInfo,
  RecentRepo,
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
  GET_CURRENT_BRANCH: 'repo:current-branch',
  GET_RECENT_REPOS: 'repo:recent',

  // Tasks
  CREATE_TASK: 'task:create',
  CLOSE_TASK: 'task:close',
  STOP_TASK: 'task:stop',
  ARCHIVE_TASK: 'task:archive',
  REOPEN_TASK: 'task:reopen',
  RENAME_TASK: 'task:rename',
  DELETE_TASK: 'task:delete',
  LIST_TASKS: 'task:list',
  REORDER_TASKS: 'tasks:reorder',

  // Terminal sessions
  CREATE_DEV_TERMINAL: 'session:create-dev-terminal',
  CLOSE_DEV_TERMINAL: 'session:close-dev-terminal',
  WRITE_TO_SESSION: 'session:write',
  RESIZE_SESSION: 'session:resize',
  DRAIN_SESSION_BUFFER: 'session:drain-buffer',

  // Diff
  GET_DIFF: 'diff:get',
  GET_DIFF_STATS: 'diff:stats',
  GET_FILE_STATUSES: 'diff:file-statuses',
  GET_GIT_LOG: 'git:log',
  GET_PR_URL: 'git:pr-url',

  // Shell
  OPEN_URL: 'shell:open-url',

  // Activity Log
  GET_ACTIVITY_LOG: 'activity:get-log',
  CLEAR_ACTIVITY_LOG: 'activity:clear',

  // IDE
  OPEN_IN_IDE: 'ide:open',
  GET_LAST_CHANGED_FILE: 'ide:last-changed-file',

  // Terminal title
  SET_TERMINAL_TITLE: 'task:set-terminal-title',

  // Context capture
  CAPTURE_CONTEXT: 'context:capture',
  FIND_TRANSCRIPT_MATCH: 'context:find-transcript-match',
  GET_API_PORT: 'api:get-port',

  // Claude sessions
  LIST_CLAUDE_SESSIONS: 'claude:list-sessions',
  RESUME_CLAUDE_SESSION: 'claude:resume-session',

  // Review
  RUN_REVIEW: 'review:run',
  SAVE_REVIEW: 'review:save',
  LOAD_REVIEW: 'review:load',
  RESUME_REVIEW: 'review:resume',

  // Integration
  CHECK_INTEGRATION: 'integration:check',
  INSTALL_INTEGRATION: 'integration:install',

  // Notifications
  SET_ACTIVE_TASK_ID: 'notify:set-active-task',
  GET_LAST_ASSISTANT_MESSAGE: 'notify:last-assistant-message',

  // Dialog
  SELECT_DIRECTORY: 'dialog:select-directory',

  // Clipboard
  READ_CLIPBOARD: 'clipboard:read',

  // PR
  FETCH_PR_INFO: 'pr:fetch-info',
  MATCH_REPO_FOR_PR: 'pr:match-repo',
  CHECK_GH_AVAILABLE: 'gh:check',

  // Permission
  RESOLVE_PERMISSION: 'permission:resolve',
} as const;

// Streaming channels (send/on)
export const IPC_STREAM = {
  SESSION_DATA: 'session:data',
  SESSION_EXIT: 'session:exit',
  ACTIVITY_ENTRY: 'activity:entry',
  TASK_SUMMARY: 'task:summary',
  REVIEW_PROGRESS: 'review:progress',
  MENU_ACTION: 'menu:action',
  HOOK_NOTIFICATION: 'hook:notification',
  PERMISSION_PROMPT: 'permission:prompt',
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
  getCurrentBranch(repoId: string): Promise<string>;
  getRecentRepos(): Promise<RecentRepo[]>;

  // Tasks
  createTask(params: CreateTaskParams): Promise<Task>;
  closeTask(taskId: string): Promise<void>;
  stopTask(taskId: string): Promise<Task>;
  archiveTask(taskId: string): Promise<Task>;
  reopenTask(taskId: string): Promise<Task>;
  renameTask(taskId: string, name: string): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  listTasks(): Promise<Task[]>;
  reorderTasks(taskIds: string[]): Promise<void>;

  // Terminal
  createDevTerminal(taskId: string): Promise<string>;
  closeDevTerminal(taskId: string): Promise<void>;
  writeToSession(sessionId: string, data: string): Promise<void>;
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>;
  drainSessionBuffer(sessionId: string): Promise<string>;
  onSessionData(callback: (sessionId: string, data: string) => void): () => void;
  onSessionExit(callback: (sessionId: string, code: number) => void): () => void;

  // Diff
  getDiff(taskId: string, scope?: 'working' | 'all'): Promise<DiffResult>;
  getDiffStats(taskId: string, scope?: 'working' | 'all'): Promise<DiffStats | null>;
  getFileStatuses(taskId: string): Promise<Record<string, string[]>>;
  getGitLog(taskId: string): Promise<GitLogEntry[]>;
  getPrUrl(taskId: string): Promise<string | null>;

  // Shell
  openUrl(url: string): Promise<void>;

  // Activity Log
  getActivityLog(taskId: string): Promise<ActivityEntry[]>;
  clearActivityLog(taskId: string): Promise<void>;
  onActivityEntry(callback: (entry: ActivityEntry) => void): () => void;

  // Terminal title
  setTerminalTitle(taskId: string, title: string): Promise<void>;

  // IDE
  openInIde(worktreePath: string, filePath?: string, line?: number): Promise<void>;
  getLastChangedFile(taskId: string): Promise<string | null>;

  // Context capture
  captureContext(params: CaptureContextParams): Promise<number>;
  findTranscriptMatch(worktreePath: string, searchText: string): Promise<{ jsonlPath: string; lineNumber: number; uuid: string } | null>;
  getApiPort(): Promise<number | null>;

  // Claude sessions
  listClaudeSessions(): Promise<ClaudeSession[]>;
  resumeClaudeSession(claudeSessionId: string, cwd: string): Promise<Task>;

  // Review
  runReview(taskId: string, scope?: 'working' | 'all', instructions?: string): Promise<{ markdown: string; reviewSessionId?: string }>;
  saveReview(taskId: string, content: string): Promise<void>;
  loadReview(taskId: string): Promise<string | null>;
  resumeReview(taskId: string): Promise<string>;

  // Review progress
  onReviewProgress(callback: (taskId: string, content: string) => void): () => void;

  // Integration
  checkIntegration(): Promise<{ installed: boolean; updateAvailable: boolean }>;
  installIntegration(): Promise<void>;

  // Dialog
  selectDirectory(): Promise<string | null>;

  // Clipboard
  readClipboard(): Promise<string>;

  // PR
  fetchPrInfo(repoId: string, prNumber: number, ghRepo?: string): Promise<PrInfo>;
  matchRepoForPr(owner: string, repo: string): Promise<string | null>;
  checkGhAvailable(): Promise<boolean>;

  // Task summary
  onTaskSummary(callback: (taskId: string, summary: string) => void): () => void;

  // Notifications
  setActiveTaskId(taskId: string | null): Promise<void>;
  getLastAssistantMessage(taskId: string): Promise<string | null>;

  // Hook notifications
  onHookNotification(callback: (taskId: string, taskName: string, message: string,
    title: string, notificationType: string) => void): () => void;

  // Permission prompts
  onPermissionPrompt(callback: (request: PermissionPromptData) => void): () => void;
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>;

  // Menu actions
  onMenuAction(callback: (action: string) => void): () => void;
}
