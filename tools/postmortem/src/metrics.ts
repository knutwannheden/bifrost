import type { ToolEvent, TokenTimeline, DiffSummary, SessionMetrics, BacktrackEntry } from "./types.js";

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
  const hasDiff = diffFiles.size > 0;
  const hasMutations = events.some((e) => e.category === "mutation");

  // TTCF and navigation overhead require both a diff and mutations to be meaningful.
  // A sub-task with no edits (e.g., "commit and push") has no target file.
  const canMeasureTargeting = hasDiff && hasMutations;

  return {
    costPerDiffLine: computeCostPerDiffLine(tokenTimeline, diff),
    timeToFirstCorrectFile: canMeasureTargeting ? computeTimeToFirstCorrectFile(events, diffFiles) : Number.NaN,
    navigationOverhead: canMeasureTargeting ? computeNavigationOverhead(events, diffFiles) : Number.NaN,
    ...computeAimlessBacktracks(events),
    testCycleCount: computeTestCycleCount(events),
    contextPressurePeak: computeContextPressurePeak(tokenTimeline, contextWindowSize),
    mutationDiscoveryWaste: hasDiff ? computeMutationDiscoveryWaste(events, diffFiles) : Number.NaN,
  };
}

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
        // Pathless mutation (e.g., Bash write command) breaks the backtrack chain
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
