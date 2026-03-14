/** Tool event categories */
export type ToolCategory = "navigation" | "mutation" | "test" | "other";

/** Normalized tool event extracted from a transcript */
export interface ToolEvent {
  timestamp: string;
  toolName: string;
  input: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  filePath?: string;
  category: ToolCategory;
  /** For mutation events, the content that was written */
  writtenContent?: string;
}

/** Per-turn token usage */
export interface TokenTurn {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Token timeline for a session */
export interface TokenTimeline {
  turns: TokenTurn[];
  /** Total context fill tokens (input + cache creation + cache read) */
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Cost-weighted token estimate: non-cached input + cache_creation*1.25 + cache_read*0.1 + output*5 */
  totalCostWeightedTokens: number;
}

/** Summary of a parsed unified diff */
export interface DiffSummary {
  totalAdded: number;
  totalRemoved: number;
  files: DiffFile[];
}

/** Per-file diff information */
export interface DiffFile {
  path: string;
  linesAdded: number;
  linesRemoved: number;
  isNew: boolean;
  isDeleted: boolean;
  addedLines: string[];
}

/** All computed session metrics */
export interface SessionMetrics {
  // --- Diff-dependent metrics (NaN when no diff) ---
  /** Cost-weighted tokens / total diff lines changed */
  costPerDiffLine: number;
  /** Fraction of session elapsed before first touch of a diff-relevant file */
  timeToFirstCorrectFile: number;
  /** Navigation tool calls before first diff-relevant mutation */
  navigationOverhead: number;
  /** Fraction of mutated files not in the final diff */
  mutationDiscoveryWaste: number;

  // --- Always-available metrics ---
  /** Writes to the same file without intervening test or cross-file mutation */
  aimlessBacktracks: number;
  /** Per-file backtrack counts, sorted descending */
  backtrackDetail: BacktrackEntry[];
  /** Number of red-to-green test transitions */
  testCycleCount: number;
  /** Highest single-turn input_tokens / context window size */
  contextPressurePeak: number;

  // --- New: always-available behavioral metrics ---
  /** Fraction of edited files that were not read first */
  editWithoutReadRate: number;
  /** Avg number of times each read file is re-read (1.0 = no re-reads) */
  fileRereadRatio: number;
  /** Fraction of edit tool calls immediately followed by another edit (no test/read between) */
  editEditChainRate: number;
  /** Human prompts per 100 tool calls (steering frequency) */
  humanCorrectionDensity: number;
  /** Tool calls that returned errors / total tool calls */
  toolErrorRate: number;
  /** Median unique files touched per sliding window of tool calls */
  fileFocusScore: number;
}

/** Per-file backtrack count */
export interface BacktrackEntry {
  filePath: string;
  count: number;
}

/** Severity level for metric thresholds */
export type Severity = "ok" | "warn" | "critical";

/** Cost efficiency tier */
export type CostTier = "efficient" | "moderate" | "expensive";

/** Session classification after bucketing */
export interface SessionBucket {
  costTier: CostTier;
  dominantWaste: keyof SessionMetrics | "none";
  recommendation: string;
}

/** A sub-task within a session, bounded by human prompts */
export interface SubTask {
  /** The human prompt that initiated this sub-task */
  promptText: string;
  /** Index into the original transcript entries */
  startIndex: number;
  /** Exclusive end index */
  endIndex: number;
  /** Tool events belonging to this sub-task */
  events: ToolEvent[];
  /** Token turns belonging to this sub-task */
  tokenTimeline: TokenTimeline;
  /** Computed metrics for this sub-task */
  metrics: SessionMetrics;
  /** Bucketing classification for this sub-task */
  bucket: SessionBucket;
  /** Flagged metrics for this sub-task */
  flags: MetricFlag[];
}

/** Subagent summary included in a session report */
export interface SubagentSummary {
  count: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEvents: number;
}

/** Report output for a single session */
export interface SessionReport {
  metrics: SessionMetrics;
  bucket: SessionBucket;
  flags: MetricFlag[];
  tokenTimeline: TokenTimeline;
  diffSummary: DiffSummary;
  /** Per-sub-task breakdown (empty if session has only one human prompt) */
  subTasks: SubTask[];
  /** Summary of merged subagent data (if any) */
  subagents: SubagentSummary;
}

/** A flagged metric with severity and recommendation */
export interface MetricFlag {
  metric: keyof SessionMetrics;
  value: number;
  severity: Severity;
  recommendation: string;
}
