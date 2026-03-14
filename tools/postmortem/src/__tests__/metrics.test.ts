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
  const mapped = turns.map((t, i) => ({
    timestamp: `2026-01-01T00:${String(i).padStart(2, "0")}:00Z`,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }));
  const totalCostWeightedTokens = mapped.reduce((s, t) => s + t.inputTokens + t.outputTokens * 5, 0);
  return {
    turns: mapped,
    totalInputTokens: turns.reduce((s, t) => s + t.inputTokens, 0),
    totalOutputTokens: turns.reduce((s, t) => s + t.outputTokens, 0),
    totalCostWeightedTokens,
  };
}

const simpleDiff: DiffSummary = {
  totalAdded: 10,
  totalRemoved: 5,
  files: [
    { path: "src/target.ts", linesAdded: 10, linesRemoved: 5, isNew: false, isDeleted: false, addedLines: [] },
  ],
};

const emptyDiff: DiffSummary = { totalAdded: 0, totalRemoved: 0, files: [] };

describe("computeMetrics", () => {
  describe("costPerDiffLine", () => {
    it("computes cost-weighted tokens / total diff lines", () => {
      const tl = timeline([{ inputTokens: 5000, outputTokens: 1000 }]);
      const result = computeMetrics([], tl, simpleDiff);
      expect(result.costPerDiffLine).toBeCloseTo(666.67, 0);
    });

    it("returns NaN for empty diff", () => {
      const tl = timeline([{ inputTokens: 5000, outputTokens: 1000 }]);
      const result = computeMetrics([], tl, emptyDiff);
      expect(result.costPerDiffLine).toBeNaN();
    });
  });

  describe("NaN for unavailable metrics", () => {
    it("returns NaN for TTCF when diff is empty", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/b.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), emptyDiff);
      expect(result.timeToFirstCorrectFile).toBeNaN();
    });

    it("returns NaN for TTCF when no mutations exist", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", filePath: "src/a.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.timeToFirstCorrectFile).toBeNaN();
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
        event({ toolName: "Read", category: "navigation", filePath: "src/target.ts", timestamp: "2026-01-01T00:10:00Z" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts", timestamp: "2026-01-01T00:15:00Z" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.timeToFirstCorrectFile).toBeCloseTo(0.667, 2);
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
      expect(result.backtrackDetail).toEqual([{ filePath: "src/target.ts", count: 2 }]);
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

    it("resets on pathless mutation", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Edit", category: "mutation", filePath: "src/target.ts" }),
        event({ toolName: "Bash", category: "mutation" }),
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

    it("returns 0 when no tests are run", () => {
      const result = computeMetrics([], timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.testCycleCount).toBe(0);
    });
  });

  describe("editWithoutReadRate", () => {
    it("returns fraction of edited files not read before editing", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", filePath: "src/a.ts" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/a.ts" }), // read first
        event({ toolName: "Edit", category: "mutation", filePath: "src/b.ts" }), // not read
        event({ toolName: "Edit", category: "mutation", filePath: "src/c.ts" }), // not read
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.editWithoutReadRate).toBeCloseTo(0.667, 2); // 2/3
    });

    it("returns 0 when all files are read before editing", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", filePath: "src/a.ts" }),
        event({ toolName: "Edit", category: "mutation", filePath: "src/a.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.editWithoutReadRate).toBe(0);
    });
  });

  describe("toolErrorRate", () => {
    it("returns fraction of tool calls with errors", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", isError: false }),
        event({ toolName: "Read", category: "navigation", isError: true }),
        event({ toolName: "Edit", category: "mutation", isError: false }),
        event({ toolName: "Bash", category: "other", isError: true }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.toolErrorRate).toBe(0.5);
    });
  });

  describe("fileFocusScore", () => {
    it("returns unique file count for small event sets", () => {
      const events: ToolEvent[] = [
        event({ toolName: "Read", category: "navigation", filePath: "src/a.ts" }),
        event({ toolName: "Read", category: "navigation", filePath: "src/b.ts" }),
        event({ toolName: "Read", category: "navigation", filePath: "src/a.ts" }),
      ];
      const result = computeMetrics(events, timeline([{ inputTokens: 100, outputTokens: 50 }]), simpleDiff);
      expect(result.fileFocusScore).toBe(2);
    });
  });
});
