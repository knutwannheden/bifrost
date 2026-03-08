export type TaskStatus = 'running' | 'stopped' | 'error' | 'archived';

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  githubPath?: string; // e.g. "openrewrite/hibernate"
}

export interface Task {
  id: string;
  name: string;
  repoId: string;
  branch: string;
  worktreePath: string;
  sessionId: string;
  status: TaskStatus;
  hasUnread: boolean;
  createdAt: number;
  archivedAt?: number;
  /** Last known terminal title (from OSC 0/2) */
  terminalTitle?: string;
  /** Auto-generated one-sentence summary of what the task is doing */
  summary?: string;
  /** True if this task has no managed worktree (e.g. resumed external session) */
  isExternal?: boolean;
  /** True if this task uses the main repo directory instead of a separate worktree */
  inPlace?: boolean;
}

export interface ReviewEntry {
  id: string;
  scope: 'working' | 'all';
  instructions?: string;
  timestamp: number;
  sessionId?: string;
}

export interface Note {
  id: string; // UUID
  text: string;
  createdAt: number; // Unix timestamp
  addressed: boolean;
}

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  projectDirName: string;
  slug?: string;
  lastModified: number;
}

export interface BifrostConfig {
  repos: Repo[];
  ide: 'code' | 'idea' | 'zed';
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  permissionMode: 'default' | 'sandbox' | 'skip-permissions';
  hideTerminalOnSwitch: boolean;
  notifications: boolean;
  showTips: boolean;
  agentTeams: boolean;
  managePermissions: boolean;
  experimentalFeatures: boolean;
  ollamaModels: string[];
  theme: 'system' | 'dark' | 'light';
  terminalTheme: string;
  slack?: SlackConfig;
}

export interface CreateTaskParams {
  repoId?: string;
  /** Repo path — resolved to repoId (auto-added if not yet configured) */
  repoPath?: string;
  /** Task name — auto-generated from prompt if omitted */
  name?: string;
  branch: string;
  /** Desired git branch name for the worktree (auto-derived from task name if omitted) */
  branchName?: string;
  /** PR info for PR-sourced tasks — triggers fetch + upstream setup */
  prInfo?: PrInfo;
  /** Use the main repo directory instead of creating a separate worktree */
  inPlace?: boolean;
  /** Initial prompt sent to Claude as the first message */
  prompt?: string;
}

export interface PrInfo {
  number: number;
  title?: string; // unavailable in git-only fallback
  headBranch: string;
  headRepoOwner: string;
  headRepoName: string;
  isFork: boolean;
}

export interface AddRepoParams {
  type: 'local' | 'clone';
  path?: string;
  url?: string;
}

export interface DiffResult {
  worktreePath: string;
  diff: string;
}

export type ClaudeEventKind = 'user_message' | 'assistant_text' | 'tool_use' | 'tool_result';

export interface ActivityEntry {
  id: string;
  taskId: string;
  timestamp: number;
  type: 'file_change' | 'commit' | 'claude_event';
  filePath?: string;
  diff?: string;
  commitSha?: string;
  commitMessage?: string;
  // Claude event fields
  claudeEventKind?: ClaudeEventKind;
  claudeText?: string;
  claudeToolName?: string;
}

export interface TokenTurnTool {
  name: string;
  detail?: string;
  /** Output tokens used to generate this tool call */
  outputTokens?: number;
  /** Input tokens added by this tool's result (context growth) */
  inputTokens?: number;
}

export type TokenTurnType = 'user' | 'tool' | 'plan' | 'agent';

export interface TokenDataPoint {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Classified turn type for chart coloring */
  turnType: TokenTurnType;
  /** Tool calls made in this turn */
  tools?: TokenTurnTool[];
  /** Truncated assistant text from this turn */
  summary?: string;
  /** Output tokens for assistant text blocks */
  summaryTokens?: number;
  /** The user prompt that triggered this turn (truncated) */
  prompt?: string;
  /** True if a context compaction occurred just before this turn */
  compacted?: boolean;
}

// Context capture types

export interface ContextBase {
  id: number;
  type: string;
  taskId: string;
  taskName: string;
  capturedAt: number;
}

export interface TerminalContext extends ContextBase {
  type: 'terminal';
  content: string;
  hasSelection: boolean;
}

export interface DiffContext extends ContextBase {
  type: 'diff';
  content: string;
}

export interface ActivityContext extends ContextBase {
  type: 'activity';
  content: string;
}

export interface TranscriptContext extends ContextBase {
  type: 'transcript';
  /** Captured terminal text — always stored as fallback */
  content: string;
  jsonlPath: string;
  lineNumber: number;
  uuid: string;
  selectedText?: string;
  selectionStart?: number;
  selectionEnd?: number;
  /** Populated at resolve time from the JSONL file */
  resolvedContent?: string;
}

export type ContextEntry = TerminalContext | DiffContext | ActivityContext | TranscriptContext;

export type CaptureContextParams =
  | { type: 'terminal'; content: string; hasSelection: boolean; taskId: string; taskName: string }
  | { type: 'diff'; content: string; taskId: string; taskName: string }
  | { type: 'activity'; content: string; taskId: string; taskName: string }
  | {
      type: 'transcript';
      content: string;
      jsonlPath: string;
      lineNumber: number;
      uuid: string;
      selectedText?: string;
      selectionStart?: number;
      selectionEnd?: number;
      taskId: string;
      taskName: string;
    };

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string; // ISO 8601
}

export interface DiffStats {
  additions: number;
  deletions: number;
  filesChanged: number;
}

export interface RecentRepo {
  path: string;
  name: string;
  lastUsed: number;
  githubPath?: string;
}

export interface SkillUsageEntry {
  skill: string;
  count: number;
}

export interface ToolUsageEntry {
  tool: string;
  count: number;
}

export interface BashCommandEntry {
  command: string;
  count: number;
}

export interface ContextRotEntry {
  name: string; // Tool name, or "Bash: <normalized cmd>" for bash detail
  count: number;
  totalBytes: number;
  avgBytes: number; // computed: totalBytes / count
}

export interface EscalationEntry {
  command: string; // Base command (stripped of tail/head/grep)
  clusters: number; // Number of back-to-back clusters found
  wastedRuns: number; // Total re-runs without intervening edits
  worstCluster: number; // Largest single cluster
}

export interface StatsData {
  skillUsage: SkillUsageEntry[];
  toolUsage: ToolUsageEntry[];
  bashCommands: BashCommandEntry[];
  contextRot: ContextRotEntry[];
  tailEscalation: EscalationEntry[];
}

// Supervisor types

export type SupervisorItemStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'opened';

export interface SupervisorItem {
  id: string;
  noteId: string;
  repoId: string;
  noteText: string;
  status: SupervisorItemStatus;
  name: string;
  branch: string;
  worktreePath?: string;
  errorMessage?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  openedAsTaskId?: string;
}

export interface SupervisorState {
  running: boolean;
  concurrency: number;
  items: SupervisorItem[];
}

export const DEFAULT_CONFIG: BifrostConfig = {
  repos: [],
  ide: 'code',
  fontSize: 14,
  fontFamily: 'MesloLGS NF',
  fontWeight: 300,
  permissionMode: 'default',
  hideTerminalOnSwitch: false,
  notifications: true,
  showTips: true,
  agentTeams: false,
  managePermissions: true,
  experimentalFeatures: false,
  ollamaModels: ['phi4-mini', 'gemma3:1b'],
  theme: 'system',
  terminalTheme: 'Auto',
};

// Permission approval types

export interface RuleOption {
  label: string;
  pattern: string;
}

export interface PermissionPromptData {
  requestId: string;
  taskId: string;
  taskName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  ruleOptions: RuleOption[];
}

export interface PermissionDecision {
  action: 'allow' | 'deny';
  persist: boolean;
  scope?: 'local' | 'project' | 'user';
  rulePattern?: string;
}

export interface SlackConfig {
  clientId: string;
  clientSecret: string;
  userToken: string;
  reactions: string[];
  enabled: boolean;
}

// Notification types

export interface AppNotification {
  id: string;
  type: 'plugin-update' | 'restart-sessions' | 'info' | 'slack-reaction';
  title: string;
  message: string;
  action?: { label: string; handler: string };
  persistent?: boolean;
  read: boolean;
  timestamp: number;
}
