export type TaskStatus = 'running' | 'stopped' | 'error' | 'archived';

export type TaskOutcome = 'merged' | 'abandoned' | 'experimental' | 'superseded' | 'pending';

/** The pull request opened from a task's branch. */
export interface TaskPr {
  number: number;
  state: 'open' | 'draft' | 'merged' | 'closed';
  url: string;
  /**
   * Whether it can land. Null where there is nothing to weigh — a draft, or a
   * PR already merged or closed — and drawn as an empty half.
   */
  merge: 'conflicts' | 'changes-requested' | 'behind' | 'awaiting-review' | 'blocked' | 'mergeable' | null;
  /** How the checks are faring; null when none ran. */
  ci: 'failing' | 'running' | 'passing' | null;
  /** The run behind a 'running' or 'failing' ci, when GitHub named one. */
  checkUrl?: string;
}

export interface TaskCuration {
  outcome: TaskOutcome;
  confidence: 'auto' | 'ai' | 'user';
  reason?: string;
  prState?: 'open' | 'closed' | 'merged';
  branchMerged?: boolean;
  classifiedAt: number;
  userOverride?: TaskOutcome;
  userNote?: string;
}

export interface CuratorState {
  lastRunAt: number | null;
  running: boolean;
  lastRunResults: CuratorRunResult[];
}

export interface CuratorRunResult {
  taskId: string;
  taskName: string;
  action: 'auto-archived' | 'classified';
  outcome?: TaskOutcome;
  reason?: string;
  timestamp: number;
}

export interface Repo {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  githubPath?: string; // e.g. "openrewrite/hibernate"
  /** Set when this repo is a synthetic container for a multi-repo task */
  multiTaskId?: string;
}

export interface Task {
  id: string;
  name: string;
  repoId: string;
  /** The ref this worktree was created from. */
  baseBranch: string;
  /** The worktree's own branch; undefined when it could not be recovered. */
  branch?: string;
  worktreePath: string;
  sessionId?: string;
  status: TaskStatus;
  hasUnread: boolean;
  createdAt: number;
  archivedAt?: number;
  /** Last known terminal title (from OSC 0/2) */
  terminalTitle?: string;
  /** The task whose agent asked for this one, by id: a name can be changed, an id cannot. */
  createdByTaskId?: string;
  /** Auto-generated one-sentence summary of what the task is doing */
  summary?: string;
  /** True if this task has no managed worktree (e.g. resumed external session) */
  isExternal?: boolean;
  /** True if this task uses the main repo directory instead of a separate worktree */
  inPlace?: boolean;
  /** Previous session IDs (accumulated when /clear creates a new session) */
  sessionHistory?: string[];
  /** True while Claude is actively working (writing JSONL output) */
  claudeActive?: boolean;
  /** When the task last started, paused for input, or ended a turn. Orders the sidebar. */
  lastTurnBoundaryAt?: number;
  /** When a turn in flight was cut off by Bifrost quitting. Cleared by the next turn. */
  interruptedAt?: number;
  curation?: TaskCuration;
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

export interface Macro {
  name: string;
  hotkey?: string; // e.g. "ctrl+shift+u"
  text: string;
}

export interface BifrostConfig {
  repos: Repo[];
  ide: 'code' | 'idea' | 'zed';
  terminal: 'Terminal' | 'iTerm' | 'Ghostty' | 'Warp';
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  zoomLevel?: number;
  /** Where the window sits when it is neither maximized nor full screen. */
  windowBounds?: { x: number; y: number; width: number; height: number };
  windowMaximized?: boolean;
  permissionMode: 'default' | 'auto-mode' | 'sandbox' | 'skip-permissions';
  hideTerminalOnSwitch: boolean;
  notifications: boolean;
  showTips: boolean;
  agentTeams: boolean;
  managePermissions: boolean;
  experimentalFeatures: boolean;
  theme: 'system' | 'dark' | 'light';
  terminalTheme: string;
  /**
   * xterm.js renderer. 'dom' uses the built-in DOM renderer (robust, no
   * texture-atlas ghosting); 'webgl' uses the GPU addon (faster under heavy
   * streaming, but prone to atlas-ghosting on background-colored cells that
   * only clears on resize — see useTerminal.ts).
   */
  terminalRenderer?: 'dom' | 'webgl';
  /** When the disk-reclaim scan last ran, so it runs at most daily. */
  lastDiskScanAt?: number;
  /** Sidebar width in pixels; unset means the default. */
  sidebarWidth?: number;
  sidebarHidden?: boolean;
  /** The change feed dock, which starts closed and keeps its width once resized. */
  changeFeedOpen?: boolean;
  changeFeedWidth?: number;
  /**
   * Whether the feed shows a worktree change only while one of the session's own
   * shell commands was running. Off, it shows every change git reports, and an
   * editor save or a build lands in the feed alongside the agent's work.
   */
  changeFeedAttributedOnly?: boolean;
  /** Globs whose changes the feed leaves out; unset means the built-in list. */
  changeFeedIgnore?: string[];
  /** Names from TIME_BUCKETS whose groups are folded shut. */
  collapsedBuckets?: string[];
  /** Tasks lifted out of their time group into the sidebar's Pinned group. */
  pinnedTaskIds?: string[];
  slack?: SlackConfig;
  keybindings?: Record<string, string | null>;
  prompts?: {
    console?: string;
  };
  macros?: Macro[];
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
  /** The task whose agent asked for this one, when one did */
  createdByTaskId?: string;
  /** Repo IDs for multi-repo task — when set, repoId/branch/inPlace/prInfo are ignored */
  multiRepoIds?: string[];
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
  commitSha?: string;
  commitMessage?: string;
  // Claude event fields
  claudeEventKind?: ClaudeEventKind;
  claudeText?: string;
  claudeToolName?: string;
}

/** One unified-diff hunk: lines prefixed with ' ', '+' or '-'. */
export interface FeedHunk {
  /** The hunk's first line number in the file as it stands after the change. */
  newStart: number;
  lines: string[];
}

interface FeedItemBase {
  id: string;
  taskId: string;
  timestamp: number;
}

export interface FeedNarration extends FeedItemBase {
  kind: 'narration';
  text: string;
  /** Reasoning rather than a statement, and shown as the quieter of the two. */
  thinking?: boolean;
}

export interface FeedChange extends FeedItemBase {
  kind: 'change';
  /** Absolute path, as the tool reported it. */
  filePath: string;
  /** Path relative to the worktree, for display and for openInIde. */
  relPath: string;
  hunks: FeedHunk[];
  added: number;
  removed: number;
  /** How many edits this card merges. */
  editCount: number;
  /** A Write that created the file; `hunks` then holds its opening lines. */
  created: boolean;
  /** The card renders a capped number of lines and the change ran past it. */
  truncated: boolean;
  /** The subagent that made the change, when one did. */
  agentLabel?: string;
  /**
   * The shell command that was running when the change appeared, for a change
   * found in the worktree rather than in a tool result. It stands in for the
   * narration such a change has none of.
   */
  command?: string;
}

export interface FeedTick extends FeedItemBase {
  kind: 'tick';
  tool: string;
  detail: string;
  /** How many consecutive calls to this tool fold into the line. */
  count: number;
}

export type FeedItem = FeedNarration | FeedChange | FeedTick;

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

export interface SubagentTokenData {
  id: string;
  slug: string;
  points: TokenDataPoint[];
}

export interface TokenUsageResult {
  points: TokenDataPoint[];
  subagents: SubagentTokenData[];
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

export const DEFAULT_CONFIG: BifrostConfig = {
  repos: [],
  ide: 'code',
  terminal: 'Terminal',
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
  theme: 'system',
  terminalTheme: 'Auto',
  terminalRenderer: 'dom',
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

// Prerequisites check

export interface PrerequisiteStatus {
  git: boolean;
  claude: boolean;
  plugin: { installed: boolean; updateAvailable: boolean };
  gh: boolean;
}

// Session metrics (postmortem analysis)

export interface SessionMetricEntry {
  name: string;
  label: string;
  value: number;
  zScore: number;
  flag: 'ok' | 'warn' | 'critical';
}

export interface SessionMetricsResult {
  metrics: SessionMetricEntry[];
  cluster: {
    index: number;
    label: string;
    distances: number[];
  } | null;
  backtrackDetail: Array<{ filePath: string; count: number }>;
}

// Notification types

export interface DiskReclaimCandidate {
  worktreePath: string;
  repoId: string;
  repoName: string;
  branch?: string;
  taskId?: string;
  taskName?: string;
  sizeKb: number;
  idleDays: number;
  prMerged: boolean;
}

export interface DiskReclaimScan {
  scannedAt: number;
  candidates: DiskReclaimCandidate[];
  totalKb: number;
  /** Worktrees a gate held back, so the notification can say what it left alone. */
  keptDirty: number;
}

export interface DiskReclaimResult {
  freedKb: number;
  removed: number;
  archivedTasks: number;
  /** Candidates that stopped qualifying between the scan and the click. */
  skipped: number;
}

export interface AppNotification {
  id: string;
  type: 'plugin-update' | 'restart-sessions' | 'info' | 'slack-reaction' | 'disk-reclaim';
  title: string;
  message: string;
  action?: { label: string; handler: string };
  persistent?: boolean;
  read: boolean;
  timestamp: number;
}
