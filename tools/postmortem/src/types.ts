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
  totalInputTokens: number;
  totalOutputTokens: number;
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
  /** Total tokens (input + output) / total diff lines changed */
  costPerDiffLine: number;
  /** Fraction of session elapsed before first touch of a diff-relevant file */
  timeToFirstCorrectFile: number;
  /** Number of navigation tool calls before first diff-relevant mutation */
  navigationOverhead: number;
  /** Writes to the same file without intervening test or cross-file mutation */
  aimlessBacktracks: number;
  /** Number of red-to-green test transitions */
  testCycleCount: number;
  /** Highest single-turn input_tokens / context window size */
  contextPressurePeak: number;
  /** Fraction of mutated files not in the final diff */
  mutationDiscoveryWaste: number;
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

/** Report output for a single session */
export interface SessionReport {
  metrics: SessionMetrics;
  bucket: SessionBucket;
  flags: MetricFlag[];
  tokenTimeline: TokenTimeline;
  diffSummary: DiffSummary;
}

/** A flagged metric with severity and recommendation */
export interface MetricFlag {
  metric: keyof SessionMetrics;
  value: number;
  severity: Severity;
  recommendation: string;
}
