import { describe, it, expect } from "vitest";
import { bucketSession, flagMetrics } from "../bucketing.js";
import type { SessionMetrics, ToolEvent } from "../types.js";

function baseMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    costPerDiffLine: 100,
    timeToFirstCorrectFile: 0.1,
    aimlessBacktracks: 0,
    backtrackDetail: [],
    testCycleCount: 1,
    editWithoutReadRate: 0,
    humanCorrectionDensity: 5,
    toolErrorRate: 0.01,
    fileFocusScore: 10,
    ...overrides,
  };
}

describe("bucketSession", () => {
  it("classifies efficient session", () => {
    const bucket = bucketSession(baseMetrics());
    expect(bucket.costTier).toBe("efficient");
    expect(bucket.dominantWaste).toBe("none");
  });

  it("classifies moderate cost with high TTCF as explorer", () => {
    const bucket = bucketSession(baseMetrics({
      costPerDiffLine: 5000,
      timeToFirstCorrectFile: 0.6,
    }));
    expect(bucket.costTier).toBe("moderate");
    expect(bucket.dominantWaste).toBe("timeToFirstCorrectFile");
  });

  it("classifies expensive session with high backtracks", () => {
    const bucket = bucketSession(baseMetrics({
      costPerDiffLine: 15000,
      aimlessBacktracks: 100,
    }));
    expect(bucket.costTier).toBe("expensive");
    expect(bucket.dominantWaste).toBe("aimlessBacktracks");
  });

  it("classifies expensive session with high error rate", () => {
    const bucket = bucketSession(baseMetrics({
      costPerDiffLine: 12000,
      toolErrorRate: 0.12,
    }));
    expect(bucket.costTier).toBe("expensive");
    expect(bucket.dominantWaste).toBe("toolErrorRate");
  });

  it("returns none for dominant waste when no metric exceeds warn", () => {
    const bucket = bucketSession(baseMetrics({ costPerDiffLine: 5000 }));
    expect(bucket.costTier).toBe("moderate");
    expect(bucket.dominantWaste).toBe("none");
  });

  it("handles NaN cost (empty diff) gracefully", () => {
    const bucket = bucketSession(baseMetrics({ costPerDiffLine: Number.NaN }));
    expect(bucket.costTier).toBe("moderate");
    expect(bucket.recommendation).toContain("No diff available");
  });

  it("skips NaN metrics when finding dominant waste", () => {
    const bucket = bucketSession(baseMetrics({
      costPerDiffLine: 15000,
      timeToFirstCorrectFile: Number.NaN,
      aimlessBacktracks: 100,
    }));
    expect(bucket.dominantWaste).toBe("aimlessBacktracks");
  });

  it("uses noTestRecommendation when no test events provided", () => {
    const noTestEvents: ToolEvent[] = [
      { timestamp: "", toolName: "Edit", input: {}, resultText: "", isError: false, category: "mutation" },
    ];
    const bucket = bucketSession(baseMetrics({ costPerDiffLine: 15000, aimlessBacktracks: 100 }), noTestEvents);
    expect(bucket.recommendation).toContain("verification step");
  });
});

describe("flagMetrics", () => {
  it("returns no flags for healthy metrics", () => {
    const flags = flagMetrics(baseMetrics());
    expect(flags).toHaveLength(0);
  });

  it("does not flag moderate backtracks (below warn=40)", () => {
    const flags = flagMetrics(baseMetrics({ aimlessBacktracks: 30 }));
    expect(flags.find((f) => f.metric === "aimlessBacktracks")).toBeUndefined();
  });

  it("flags high backtracks as warn", () => {
    const flags = flagMetrics(baseMetrics({ aimlessBacktracks: 50 }));
    const flag = flags.find((f) => f.metric === "aimlessBacktracks");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warn");
  });

  it("flags critical backtracks", () => {
    const flags = flagMetrics(baseMetrics({ aimlessBacktracks: 100 }));
    const flag = flags.find((f) => f.metric === "aimlessBacktracks");
    expect(flag!.severity).toBe("critical");
  });

  it("flags high TTCF as warn", () => {
    const flags = flagMetrics(baseMetrics({ timeToFirstCorrectFile: 0.35 }));
    const flag = flags.find((f) => f.metric === "timeToFirstCorrectFile");
    expect(flag!.severity).toBe("warn");
  });

  it("flags high edit-without-read as warn", () => {
    const flags = flagMetrics(baseMetrics({ editWithoutReadRate: 0.4 }));
    const flag = flags.find((f) => f.metric === "editWithoutReadRate");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warn");
  });

  it("flags high tool error rate as critical", () => {
    const flags = flagMetrics(baseMetrics({ toolErrorRate: 0.15 }));
    const flag = flags.find((f) => f.metric === "toolErrorRate");
    expect(flag!.severity).toBe("critical");
  });

  it("skips NaN metrics", () => {
    const flags = flagMetrics(baseMetrics({ timeToFirstCorrectFile: Number.NaN }));
    expect(flags.find((f) => f.metric === "timeToFirstCorrectFile")).toBeUndefined();
  });

  it("flags multiple metrics at once", () => {
    const flags = flagMetrics(baseMetrics({
      timeToFirstCorrectFile: 0.6,
      aimlessBacktracks: 100,
      toolErrorRate: 0.12,
    }));
    expect(flags.length).toBeGreaterThanOrEqual(3);
  });
});
