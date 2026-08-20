import type {
  ActivityEntry,
  AddRepoParams,
  BifrostConfig,
  CaptureContextParams,
  ClaudeSession,
  CreateTaskParams,
  CuratorState,
  DiffResult,
  DiffStats,
  GitLogEntry,
  Note,
  PermissionDecision,
  PermissionPromptData,
  PrInfo,
  RecentRepo,
  Repo,
  ReviewEntry,
  SessionMetricsResult,
  StatsData,
  Task,
  TaskCuration,
  TaskOutcome,
  TokenUsageResult,
  TriageEntry,
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
  IS_WORKTREE_DIRTY: 'task:is-worktree-dirty',
  REOPEN_TASK: 'task:reopen',
  RENAME_TASK: 'task:rename',
  REGENERATE_TASK_TITLE: 'task:regenerate-title',
  DELETE_TASK: 'task:delete',
  LIST_TASKS: 'task:list',
  REORDER_TASKS: 'tasks:reorder',
  GET_SESSION_MTIMES: 'task:session-mtimes',

  // Terminal sessions
  CREATE_DEV_TERMINAL: 'session:create-dev-terminal',
  CLOSE_DEV_TERMINAL: 'session:close-dev-terminal',
  WRITE_TO_SESSION: 'session:write',
  RESIZE_SESSION: 'session:resize',
  ATTACH_SESSION: 'session:attach',

  // Diff
  GET_DIFF: 'diff:get',
  GET_DIFF_STATS: 'diff:stats',
  GET_FILE_STATUSES: 'diff:file-statuses',
  GET_GIT_LOG: 'git:log',
  GET_PR_URL: 'git:pr-url',

  // Shell
  OPEN_URL: 'shell:open-url',
  OPEN_IN_TERMINAL: 'shell:open-in-terminal',

  // Activity Log
  GET_ACTIVITY_LOG: 'activity:get-log',
  CLEAR_ACTIVITY_LOG: 'activity:clear',
  GET_FILE_DIFF: 'activity:file-diff',

  // Token Usage
  GET_TOKEN_USAGE: 'token:get-usage',

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
  CANCEL_REVIEW: 'review:cancel',
  SAVE_REVIEW: 'review:save',
  LOAD_REVIEW: 'review:load',
  RESUME_REVIEW: 'review:resume',
  LIST_REVIEWS: 'review:list',
  DELETE_REVIEW: 'review:delete',
  CLOSE_REVIEW_SESSION: 'review:close-session',

  // Integration
  CHECK_INTEGRATION: 'integration:check',
  INSTALL_INTEGRATION: 'integration:install',
  CHECK_PREREQUISITES: 'integration:prerequisites',
  INSTALL_OLLAMA_MODEL: 'integration:install-ollama-model',

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

  // Notes
  NOTE_LIST: 'note:list',
  NOTE_CREATE: 'note:create',
  NOTE_UPDATE: 'note:update',
  NOTE_DELETE: 'note:delete',

  // Permission
  RESOLVE_PERMISSION: 'permission:resolve',

  // Session Metrics
  GET_SESSION_METRICS: 'metrics:get-session',

  // Stats
  GET_STATS: 'stats:get',

  // Slack
  SLACK_START_OAUTH: 'slack:start-oauth',
  SLACK_DISCONNECT: 'slack:disconnect',

  // Triage
  START_TRIAGE: 'triage:start',
  CANCEL_TRIAGE: 'triage:cancel',
  LIST_TRIAGES: 'triage:list',
  DELETE_TRIAGE: 'triage:delete',
  ENTER_TRIAGE: 'triage:enter',

  // Prompt sender
  SEND_PROMPT: 'prompt:send',
  SCRAPE_PROMPT_RESPONSE: 'prompt:scrape-response',

  // Curator
  CURATOR_GET_STATE: 'curator:get-state',
  CURATOR_SET_OUTCOME: 'curator:set-outcome',
  CURATOR_RUN_NOW: 'curator:run-now',
} as const;

// Streaming channels (send/on)
export const IPC_STREAM = {
  SESSION_DATA: 'session:data',
  SESSION_EXIT: 'session:exit',
  ACTIVITY_ENTRY: 'activity:entry',
  TASK_SUMMARY: 'task:summary',
  REVIEW_PROGRESS: 'review:progress',
  REVIEW_SESSION: 'review:session',
  REVIEW_ACTIVITY: 'review:activity',
  MENU_ACTION: 'menu:action',
  HOOK_NOTIFICATION: 'hook:notification',
  PERMISSION_PROMPT: 'permission:prompt',
  STATS_UPDATE: 'stats:update',
  TASK_CREATED: 'task:created',
  TASK_CLOSED: 'task:closed',
  SLACK_REACTION: 'slack:reaction',
  TRIAGE_ACTIVITY: 'triage:activity',
  TRIAGE_WAITING: 'triage:waiting',
  CLAUDE_ACTIVE: 'claude:active',
  SCRAPE_PROMPT_REQUEST: 'prompt:scrape-request',
  TERMINAL_UNLOCK: 'terminal:unlock',
  CURATOR_UPDATE: 'curator:update',
  TOAST: 'ui:toast',
} as const;

// Typed API exposed via contextBridge as window.bifrost
export interface BifrostAPI {
  // Config
  loadConfig(): Promise<BifrostConfig>;
  saveConfig(config: BifrostConfig): Promise<void>;
  setIde(ide: 'code' | 'idea' | 'zed'): Promise<void>;

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
  isWorktreeDirty(taskId: string): Promise<boolean>;
  reopenTask(taskId: string): Promise<Task>;
  renameTask(taskId: string, name: string): Promise<Task>;
  /**
   * Resolves null when the task has no transcript to summarize or generation
   * fails; `renamedBranch` is null when the worktree branch was left alone.
   */
  regenerateTaskTitle(taskId: string): Promise<{ task: Task; renamedBranch: string | null } | null>;
  deleteTask(taskId: string): Promise<void>;
  listTasks(): Promise<Task[]>;
  reorderTasks(taskIds: string[]): Promise<void>;
  getSessionMtimes(): Promise<Record<string, number>>;

  // Terminal
  createDevTerminal(taskId: string): Promise<string>;
  closeDevTerminal(taskId: string): Promise<void>;
  writeToSession(sessionId: string, data: string): void;
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>;
  /** Ask for the session's screen, shaped for a terminal of this size, and match the PTY to it. False when the session is gone. */
  attachSession(sessionId: string, cols: number, rows: number): Promise<boolean>;
  /** `isReplay` marks the attach snapshot; output before it is already part of that snapshot and can be dropped. */
  onSessionData(callback: (sessionId: string, data: string, isReplay: boolean) => void): () => void;
  onSessionExit(callback: (sessionId: string, code: number) => void): () => void;

  // Diff
  getDiff(taskId: string, scope?: 'working' | 'all'): Promise<DiffResult>;
  getDiffStats(taskId: string, scope?: 'working' | 'all'): Promise<DiffStats | null>;
  getFileStatuses(taskId: string, scope?: 'working' | 'all'): Promise<Record<string, string[]>>;
  getGitLog(taskId: string): Promise<GitLogEntry[]>;
  getPrUrl(taskId: string): Promise<string | null>;

  // Shell
  openUrl(url: string): Promise<void>;
  openInTerminal(dirPath: string): Promise<void>;
  onZoomChanged(callback: (pct: number) => void): () => void;

  // Activity Log
  getActivityLog(taskId: string): Promise<ActivityEntry[]>;
  clearActivityLog(taskId: string): Promise<void>;
  getFileDiff(worktreePath: string, filePath: string): Promise<string>;
  onActivityEntry(callback: (entry: ActivityEntry) => void): () => void;

  // Token Usage
  getTokenUsage(taskId: string): Promise<TokenUsageResult>;

  // Terminal title
  setTerminalTitle(taskId: string, title: string): Promise<void>;

  // IDE
  openInIde(worktreePath: string, filePath?: string, line?: number): Promise<void>;
  getLastChangedFile(taskId: string): Promise<string | null>;

  // Context capture
  captureContext(params: CaptureContextParams): Promise<number>;
  findTranscriptMatch(
    worktreePath: string,
    searchText: string,
  ): Promise<{ jsonlPath: string; lineNumber: number; uuid: string } | null>;
  getApiPort(): Promise<number | null>;

  // Claude sessions
  listClaudeSessions(): Promise<ClaudeSession[]>;
  resumeClaudeSession(externalSessionId: string, cwd: string): Promise<Task>;

  // Review
  runReview(
    taskId: string,
    scope?: 'working' | 'all',
    instructions?: string,
  ): Promise<{ reviewId: string; markdown: string; sessionId?: string }>;
  cancelReview(taskId: string): Promise<void>;
  saveReview(taskId: string, reviewId: string, content: string): Promise<void>;
  loadReview(taskId: string, reviewId: string): Promise<string | null>;
  resumeReview(taskId: string, reviewId: string): Promise<string>;
  listReviews(taskId: string): Promise<ReviewEntry[]>;
  deleteReview(taskId: string, reviewId: string): Promise<void>;
  closeReviewSession(taskId: string): Promise<void>;

  // Review progress
  onReviewProgress(callback: (taskId: string, reviewId: string, content: string) => void): () => void;
  onReviewSession(callback: (taskId: string, reviewId: string, sessionId: string) => void): () => void;
  onReviewActivity(callback: (taskId: string, reviewId: string, activity: string) => void): () => void;

  // Integration
  checkIntegration(): Promise<{ installed: boolean; updateAvailable: boolean }>;
  installIntegration(): Promise<void>;
  checkPrerequisites(): Promise<import('../shared/types').PrerequisiteStatus>;
  installOllamaModel(model: string): Promise<void>;

  // Dialog
  selectDirectory(): Promise<string | null>;

  // Clipboard
  readClipboard(): Promise<string>;

  // PR
  fetchPrInfo(repoId: string, prNumber: number, ghRepo?: string): Promise<PrInfo>;
  matchRepoForPr(owner: string, repo: string): Promise<string | null>;
  checkGhAvailable(): Promise<boolean>;

  // Task events
  onTaskSummary(callback: (taskId: string, summary: string) => void): () => void;
  onTaskCreated(callback: (task: Task) => void): () => void;
  onTaskClosed(callback: (taskId: string, archived: boolean) => void): () => void;

  // Notifications
  setActiveTaskId(taskId: string | null): Promise<void>;
  getLastAssistantMessage(taskId: string): Promise<string | null>;

  // Hook notifications
  onHookNotification(
    callback: (taskId: string, taskName: string, message: string, title: string, notificationType: string) => void,
  ): () => void;

  // Permission prompts
  onPermissionPrompt(callback: (request: PermissionPromptData) => void): () => void;
  resolvePermission(requestId: string, decision: PermissionDecision): Promise<void>;

  // Notes
  listNotes(repoId: string): Promise<Note[]>;
  createNote(repoId: string, text: string): Promise<Note>;
  updateNote(repoId: string, noteId: string, updates: { text?: string; addressed?: boolean }): Promise<Note>;
  deleteNote(repoId: string, noteId: string): Promise<void>;

  // Session Metrics
  getSessionMetrics(taskId: string): Promise<SessionMetricsResult>;

  // Stats
  getStats(since?: number): Promise<void>;
  onStatsUpdate(callback: (data: StatsData) => void): () => void;

  // Slack
  startSlackOAuth(): Promise<void>;
  disconnectSlack(): Promise<void>;
  onSlackReaction(
    callback: (channelId: string, messageTs: string, messageUrl: string, messagePreview: string) => void,
  ): () => void;

  // Triage
  startTriage(prompt: string): Promise<{ triageId: string; ptySessionId: string }>;
  cancelTriage(triageId: string): Promise<void>;
  listTriages(): Promise<TriageEntry[]>;
  deleteTriage(triageId: string): Promise<void>;
  enterTriage(triageId: string): Promise<{ ptySessionId: string } | null>;
  onTriageActivity(callback: (triageId: string, activity: string) => void): () => void;
  onTriageWaiting(callback: (triageId: string, message: string) => void): () => void;

  // Claude activity
  onClaudeActive(callback: (taskId: string, active: boolean) => void): () => void;

  // Prompt sender
  sendPrompt(
    taskId: string,
    text: string,
    mode?: 'direct' | 'queue' | 'only-when-idle',
  ): Promise<{ ok: boolean; error?: string; queued?: boolean }>;
  onScrapePromptRequest(callback: (taskId: string, requestId: string) => void): () => void;
  scrapePromptResponse(requestId: string, text: string): Promise<void>;
  onTerminalUnlock(callback: (taskId: string) => void): () => void;

  // Curator
  getCuratorState(): Promise<CuratorState>;
  setCuratorOutcome(taskId: string, outcome: TaskOutcome, note?: string): Promise<Task>;
  runCuratorNow(): Promise<void>;
  onCuratorUpdate(callback: (taskId: string, curation: TaskCuration) => void): () => void;

  // Toast (main → renderer)
  onToast(callback: (message: string, duration?: number) => void): () => void;

  // Menu actions
  onMenuAction(callback: (action: string) => void): () => void;
}
