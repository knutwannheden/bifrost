import { describe, it, expect } from "vitest";
import { computeMetrics } from "../metrics.js";
import type { ToolEvent, TokenTimeline, DiffSummary } from "../types.js";

function event(
  overrides: Partial<ToolEvent> & { toolName: string; category: ToolEvent["category"] },
): ToolEvent {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    input: {},
    resultText: "",
    isError: false,
    ...overrides,
  };
}

function timeline(turns: Array<{ inputTokens: number; outputTokens: number }>): TokenTimeline {
  return {
    turns: turns.map((t, i) => ({
      timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    })),
    totalInputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    totalOutputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
  };
}

const simpleDiff: DiffSummary = {
  totalAdded: 10,
  totalRemoved: 5,
  files: [
    { path: "src/target.ts", linesAdded: 10, linesRemoved: 5, isNew: false, isDeleted: false, addedLines: [] },
  ],
};

describe("computeMetrics", () => {
  describe("costPerDiffLine", () => {
    it("computes total tokens / total diff lines", () => {
      const tl = timeline([{ inputTokens: 5000, outputTokens: 1000 }]);
      const result = computeMetrics([], tl, simpleDiff);
      // (5000 + 1000) / (10 + 5) = 400
      expect(result.costPerDiffLine).toBe(400);
    });

    it("returns Infinity for empty diff", () => {
      const tl = timeline([{ inputTokens: 5000, outputTokens: 1000 }]);
      const emptyDiff: DiffSummary = { totalAdded: 0, totalRemoved: 0, files: [] };
      const result = computeMetrics([], tl, emptyDiff);
      expect(result.costPerDiffLine).toBe(Number.POSITIVE_INFINITY);
    });
  });

  describe("timeToFirstCorrectFile", () => {
    it("returns 0 when the first event touches a diff file", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts", timestamp: "2026-01-01T00:00:00Z" }),
        event({ toolName: "Read", category: "navigation", filePath: "src/other.ts", timestamp: "2026-01-01T00:05:00Z" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.timeToFirstCorrectFile).toBe(0);
    });

    it("returns fraction of session elapsed before first touch of diff file", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", filePath: "src/other.ts", timestamp: "2026-01-01T00:00:00Z" }),
        event({ toolName: "Read", category: "navigation", filePath: "src/wrong.ts", timestamp: "2026-01-01T00:05:00Z" }),
        event({ toolName: "Read", category: "navigation", filePath: "src/target.ts", timestamp: "2026-01-01T00:10:00Z" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts", timestamp: "2026-01-01T00:15:00Z" }),
      ];
      // First touch of diff file at 10 min, session spans 0-15 min = 10/15 = 0.667
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.timeToFirstCorrectFile).toBeCloseTo(0.667, 2);
    });

    it("returns 1 when no diff file is ever touched", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", filePath: "src/other.ts", timestamp: "2026-01-01T00:00:00Z" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.timeToFirstCorrectFile).toBe(1);
    });
  });

  describe("navigationOverhead", () => {
    it("counts navigation calls before first diff-relevant mutation", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", filePath: "src/other.ts" }),
        event({ toolName: "Grep", category: "navigation", filePath: "src/foo.ts" }),
        event({ toolName: "Read", category: "navigation", filePath: "src/target.ts" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
        event({ toolName: "Read", category: "navigation", filePath: "src/bar.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.navigationOverhead).toBe(3);
    });

    it("does not count mutations to non-diff files as stopping the count", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation" }),
        event({ toolName: "Write", category: "mutation", filePath: "src/wrong.ts" }), // not in diff
        event({ toolName: "Read", category: "navigation" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }), // in diff
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.navigationOverhead).toBe(2); // two navigation calls before diff-relevant mutation
    });

    it("returns total navigation count when no diff-relevant mutation exists", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation" }),
        event({ toolName: "Glob", category: "navigation" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.navigationOverhead).toBe(2);
    });
  });

  describe("aimlessBacktracks", () => {
    it("counts consecutive writes to the same file without intervening test or cross-file mutation", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.aimlessBacktracks).toBe(2);
    });

    it("resets on test event", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
        event({ toolName: "Bash", category: "test" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.aimlessBacktracks).toBe(0);
    });

    it("resets on cross-file mutation", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
        event({ toolName: "Write", category: "mutation", filePath: "src/other.ts" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.aimlessBacktracks).toBe(0);
    });
  });

  describe("testCycleCount", () => {
    it("counts red-to-green transitions", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Bash", category: "test", resultText: "FAIL src/test.ts", isError: true }),
        event({ toolName: "Bash", category: "test", resultText: "FAIL src/test.ts", isError: true }),
        event({ toolName: "Bash", category: "test", resultText: "PASS all tests" }),
        event({ toolName: "Bash", category: "test", resultText: "FAIL another", isError: true }),
        event({ toolName: "Bash", category: "test", resultText: "PASS all tests" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.testCycleCount).toBe(2);
    });

    it("returns 0 for all-passing tests", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Bash", category: "test", resultText: "PASS all tests" }),
        event({ toolName: "Bash", category: "test", resultText: "PASS all tests" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.testCycleCount).toBe(0);
    });

    it("returns 0 when no tests are run", () => {
      const result = computeMetrics([], timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.testCycleCount).toBe(0);
    });
  });

  describe("contextPressurePeak", () => {
    it("returns max input_tokens / context window size", () => {
      const tl = timeline([
        { inputTokens: 50000, outputTokens: 1000 },
        { inputTokens: 150000, outputTokens: 2000 },
        { inputTokens: 80000, outputTokens: 500 },
      ]);
      const result = computeMetrics([], tl, simpleDiff, 200000);
      expect(result.contextPressurePeak).toBe(0.75); // 150000/200000
    });
  });

  describe("mutationDiscoveryWaste", () => {
    it("returns fraction of mutated files not in diff", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
        event({ toolName: "Write", category: "mutation", filePath: "src/waste1.ts" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/waste2.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      // 2 out of 3 mutated files not in diff
      expect(result.mutationDiscoveryWaste).toBeCloseTo(0.667, 2);
    });

    it("returns 0 when all mutations are in diff", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.mutationDiscoveryWaste).toBe(0);
    });

    it("returns 0 when there are no mutations", () => {
      const result = computeMetrics([], timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.mutationDiscoveryWaste).toBe(0);
    });
  });
});
