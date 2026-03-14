import type { ToolEvent, TokenTimeline, DiffSummary, SessionMetrics } from "./types.js";

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Compute all session metrics from tool events, token timeline, and diff summary.
 */
export function computeMetrics(
  events: ToolEvent[],
  tokenTimeline: TokenTimeline,
  diff: DiffSummary,
  contextWindowSize = DEFAULT_CONTEXT_WINDOW,
): SessionMetrics {
  const diffFiles = new Set(diff.files.map((f) => f.path));

  return {
    costPerDiffLine: computeCostPerDiffLine(tokenTimeline, diff),
    timeToFirstCorrectFile: computeTimeToFirstCorrectFile(events, diffFiles),
    navigationOverhead: computeNavigationOverhead(events, diffFiles),
    aimlessBacktracks: computeAimlessBacktracks(events),
    testCycleCount: computeTestCycleCount(events),
    contextPressurePeak: computeContextPressurePeak(tokenTimeline, contextWindowSize),
    mutationDiscoveryWaste: computeMutationDiscoveryWaste(events, diffFiles),
  };
}

function computeCostPerDiffLine(tokenTimeline: TokenTimeline, diff: DiffSummary): number {
  const totalTokens = tokenTimeline.totalInputTokens + tokenTimeline.totalOutputTokens;
  const totalDiffLines = diff.totalAdded + diff.totalRemoved;
  if (totalDiffLines === 0) return Number.POSITIVE_INFINITY;
  return totalTokens / totalDiffLines;
}

function computeTimeToFirstCorrectFile(events: ToolEvent[], diffFiles: Set<string>): number {
  if (events.length === 0) return 1;

  const timestamps = events.map((e) => new Date(e.timestamp).getTime());
  const sessionStart = Math.min(...timestamps);
  const sessionEnd = Math.max(...timestamps);
  const sessionDuration = sessionEnd - sessionStart;

  if (sessionDuration === 0) {
    // All events at same timestamp — check if any touches a diff file
    const touchesDiff = events.some((e) => e.filePath && diffFiles.has(e.filePath));
    return touchesDiff ? 0 : 1;
  }

  for (const event of events) {
    if (event.filePath && diffFiles.has(event.filePath)) {
      const eventTime = new Date(event.timestamp).getTime();
      return (eventTime - sessionStart) / sessionDuration;
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
    if (event.category === "navigation") {
      navCount++;
    }
  }
  return navCount;
}

function computeAimlessBacktracks(events: ToolEvent[]): number {
  let backtracks = 0;
  let lastMutatedFile: string | undefined;

  for (const event of events) {
    if (event.category === "test") {
      lastMutatedFile = undefined;
      continue;
    }
    if (event.category === "mutation" && event.filePath) {
      if (lastMutatedFile === event.filePath) {
        backtracks++;
      } else {
        lastMutatedFile = event.filePath;
      }
    }
  }

  return backtracks;
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
      // Transition from red to green
      cycles++;
      inFailure = false;
    }
  }

  return cycles;
}

function isTestFailure(event: ToolEvent): boolean {
  // Use error flag from tool result as primary signal
  if (event.isError) return true;

  const text = event.resultText;
  // Check for pass indicators first
  if (/\b(?:PASS|0 failed|0 errors|all tests passed)\b/i.test(text)) return false;
  // Check for failure indicators
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
