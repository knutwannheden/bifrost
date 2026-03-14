import type { TranscriptEntry } from "./claude-parser.js";
import type { ToolEvent, TokenTimeline, DiffSummary, SessionMetrics, BacktrackEntry } from "./types.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const FILE_FOCUS_WINDOW = 50;

/**
 * Compute all session metrics from tool events, token timeline, and diff summary.
 * Pass entries to compute human interaction metrics.
 */
export function computeMetrics(
  events: ToolEvent[],
  tokenTimeline: TokenTimeline,
  diff: DiffSummary,
  contextWindowSize = DEFAULT_CONTEXT_WINDOW,
  entries?: TranscriptEntry[],
): SessionMetrics {
  const diffFiles = new Set(diff.files.map((f) => f.path));
  const hasDiff = diffFiles.size > 0;
  const hasMutations = events.some((e) => e.category === "mutation");
  const canMeasureTargeting = hasDiff && hasMutations;

  return {
    // Diff-dependent
    costPerDiffLine: computeCostPerDiffLine(tokenTimeline, diff),
    timeToFirstCorrectFile: canMeasureTargeting ? computeTimeToFirstCorrectFile(events, diffFiles) : Number.NaN,
    navigationOverhead: canMeasureTargeting ? computeNavigationOverhead(events, diffFiles) : Number.NaN,
    mutationDiscoveryWaste: hasDiff ? computeMutationDiscoveryWaste(events, diffFiles) : Number.NaN,

    // Always-available (existing)
    ...computeAimlessBacktracks(events),
    testCycleCount: computeTestCycleCount(events),
    contextPressurePeak: computeContextPressurePeak(tokenTimeline, contextWindowSize),

    // Always-available (new behavioral)
    editWithoutReadRate: computeEditWithoutReadRate(events),
    fileRereadRatio: computeFileRereadRatio(events),
    editEditChainRate: computeEditEditChainRate(events),
    humanCorrectionDensity: computeHumanCorrectionDensity(events, entries),
    toolErrorRate: computeToolErrorRate(events),
    fileFocusScore: computeFileFocusScore(events),
  };
}

// --- Existing metrics ---

function computeCostPerDiffLine(tokenTimeline: TokenTimeline, diff: DiffSummary): number {
  const totalDiffLines = diff.totalAdded + diff.totalRemoved;
  if (totalDiffLines === 0) return Number.NaN;
  return tokenTimeline.totalCostWeightedTokens / totalDiffLines;
}

function computeTimeToFirstCorrectFile(events: ToolEvent[], diffFiles: Set<string>): number {
  if (events.length === 0) return 1;
  const timestamps = events.map((e) => new Date(e.timestamp).getTime());
  const sessionStart = Math.min(...timestamps);
  const sessionEnd = Math.max(...timestamps);
  const sessionDuration = sessionEnd - sessionStart;
  if (sessionDuration === 0) {
    return events.some((e) => e.filePath && diffFiles.has(e.filePath)) ? 0 : 1;
  }
  for (const event of events) {
    if (event.filePath && diffFiles.has(event.filePath)) {
      return (new Date(event.timestamp).getTime() - sessionStart) / sessionDuration;
    }
  }
  return 1;
}

function computeNavigationOverhead(events: ToolEvent[], diffFiles: Set<string>): number {
  let navCount = 0;
  for (const event of events) {
    if (event.category === "mutation" && event.filePath && diffFiles.has(event.filePath)) {
      return navCount;
    }
    if (event.category === "navigation") navCount++;
  }
  return navCount;
}

function computeAimlessBacktracks(events: ToolEvent[]): { aimlessBacktracks: number; backtrackDetail: BacktrackEntry[] } {
  let backtracks = 0;
  let lastMutatedFile: string | undefined;
  const perFile = new Map<string, number>();

  for (const event of events) {
    if (event.category === "test") {
      lastMutatedFile = undefined;
      continue;
    }
    if (event.category === "mutation") {
      if (!event.filePath) {
        lastMutatedFile = undefined;
      } else if (lastMutatedFile === event.filePath) {
        backtracks++;
        perFile.set(event.filePath, (perFile.get(event.filePath) || 0) + 1);
      } else {
        lastMutatedFile = event.filePath;
      }
    }
  }

  const backtrackDetail = Array.from(perFile.entries())
    .map(([filePath, count]) => ({ filePath, count }))
    .sort((a, b) => b.count - a.count);

  return { aimlessBacktracks: backtracks, backtrackDetail };
}

function computeTestCycleCount(events: ToolEvent[]): number {
  const testEvents = events.filter((e) => e.category === "test");
  let cycles = 0;
  let inFailure = false;
  for (const event of testEvents) {
    const failed = isTestFailure(event);
    if (failed) {
      inFailure = true;
    } else if (inFailure) {
      cycles++;
      inFailure = false;
    }
  }
  return cycles;
}

function isTestFailure(event: ToolEvent): boolean {
  if (event.isError) return true;
  const text = event.resultText;
  if (/\b(?:PASS|0 failed|0 errors|all tests passed)\b/i.test(text)) return false;
  if (/\b(?:FAIL|FAILED|Tests failed|FAILURES)\b/.test(text)) return true;
  return false;
}

function computeContextPressurePeak(tokenTimeline: TokenTimeline, contextWindowSize: number): number {
  if (tokenTimeline.turns.length === 0) return 0;
  const maxInput = Math.max(...tokenTimeline.turns.map((t) => t.inputTokens));
  return maxInput / contextWindowSize;
}

function computeMutationDiscoveryWaste(events: ToolEvent[], diffFiles: Set<string>): number {
  const mutatedFiles = new Set<string>();
  for (const event of events) {
    if (event.category === "mutation" && event.filePath) {
      mutatedFiles.add(event.filePath);
    }
  }
  if (mutatedFiles.size === 0) return 0;
  let wasteCount = 0;
  for (const file of mutatedFiles) {
    if (!diffFiles.has(file)) wasteCount++;
  }
  return wasteCount / mutatedFiles.size;
}

// --- New behavioral metrics ---

/**
 * Fraction of edited files that were never read before the first edit.
 * High = blind edits. Low = careful, read-first approach.
 */
function computeEditWithoutReadRate(events: ToolEvent[]): number {
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();
  const editedWithoutRead = new Set<string>();

  for (const event of events) {
    if (event.category === "navigation" && event.filePath && event.toolName === "Read") {
      readFiles.add(event.filePath);
    }
    if (event.category === "mutation" && event.filePath && !editedFiles.has(event.filePath)) {
      editedFiles.add(event.filePath);
      if (!readFiles.has(event.filePath)) {
        editedWithoutRead.add(event.filePath);
      }
    }
  }

  if (editedFiles.size === 0) return 0;
  return editedWithoutRead.size / editedFiles.size;
}

/**
 * Average read count per unique file read. 1.0 = each file read once.
 * High values indicate the agent repeatedly re-reads files (losing context).
 */
function computeFileRereadRatio(events: ToolEvent[]): number {
  const readCounts = new Map<string, number>();
  for (const event of events) {
    if (event.toolName === "Read" && event.filePath) {
      readCounts.set(event.filePath, (readCounts.get(event.filePath) || 0) + 1);
    }
  }
  if (readCounts.size === 0) return 1;
  const totalReads = Array.from(readCounts.values()).reduce((s, c) => s + c, 0);
  return totalReads / readCounts.size;
}

/**
 * Fraction of mutation events immediately followed by another mutation
 * (no read, test, or other tool between them).
 * High = rapid-fire edits without verification.
 */
function computeEditEditChainRate(events: ToolEvent[]): number {
  let mutationCount = 0;
  let editEditCount = 0;
  let lastWasMutation = false;

  for (const event of events) {
    if (event.category === "mutation") {
      mutationCount++;
      if (lastWasMutation) editEditCount++;
      lastWasMutation = true;
    } else {
      lastWasMutation = false;
    }
  }

  if (mutationCount <= 1) return 0;
  return editEditCount / (mutationCount - 1);
}

/**
 * Human prompts per 100 tool calls. Measures how frequently the human
 * needs to steer the agent. High = agent needs constant guidance.
 */
function computeHumanCorrectionDensity(events: ToolEvent[], entries?: TranscriptEntry[]): number {
  if (events.length === 0) return 0;

  let humanPrompts = 0;
  if (entries) {
    for (const entry of entries) {
      const e = entry as TranscriptEntry & { userType?: string };
      if (e.type !== "user" || e.userType !== "external") continue;
      const content = e.message?.content;
      if (typeof content === "string") {
        // Skip system-injected messages
        if (content.startsWith("<local-command-caveat>")) continue;
        if (content.startsWith("<bash-input>")) continue;
        if (content.startsWith("<command-name>")) continue;
        humanPrompts++;
      } else if (Array.isArray(content)) {
        const hasToolResult = (content as Array<Record<string, unknown>>).some((b) => b.type === "tool_result");
        if (!hasToolResult) humanPrompts++;
      }
    }
  }

  return (humanPrompts / events.length) * 100;
}

/**
 * Fraction of tool calls that returned an error.
 */
function computeToolErrorRate(events: ToolEvent[]): number {
  if (events.length === 0) return 0;
  const errors = events.filter((e) => e.isError).length;
  return errors / events.length;
}

/**
 * Median unique files touched per sliding window of tool calls.
 * Low = focused on few files. High = scattered across many.
 * Returned as the inverse: 1/median, so higher = more focused.
 */
function computeFileFocusScore(events: ToolEvent[]): number {
  const fileEvents = events.filter((e) => e.filePath);
  if (fileEvents.length < FILE_FOCUS_WINDOW) {
    // Too few events — compute diversity over all of them
    const unique = new Set(fileEvents.map((e) => e.filePath));
    return unique.size || 0;
  }

  const diversities: number[] = [];
  for (let i = 0; i <= fileEvents.length - FILE_FOCUS_WINDOW; i += FILE_FOCUS_WINDOW) {
    const chunk = fileEvents.slice(i, i + FILE_FOCUS_WINDOW);
    const unique = new Set(chunk.map((e) => e.filePath));
    diversities.push(unique.size);
  }

  diversities.sort((a, b) => a - b);
  return diversities[Math.floor(diversities.length / 2)];
}
