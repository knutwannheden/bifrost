import { describe, it, expect } from "vitest";
import { bucketSession, flagMetrics } from "../bucketing.js";
import type { SessionMetrics, ToolEvent } from "../types.js";

function baseMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    costPerDiffLine: 100,
    timeToFirstCorrectFile: 0.1,
    navigationOverhead: 3,
    mutationDiscoveryWaste: 0.1,
    aimlessBacktracks: 0,
    backtrackDetail: [],
    testCycleCount: 1,
    contextPressurePeak: 0.3,
    editWithoutReadRate: 0,
    fileRereadRatio: 1,
    editEditChainRate: 0,
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

  it("classifies expensive session with high context pressure", () => {
    const bucket = bucketSession(baseMetrics({
      costPerDiffLine: 12000,
      contextPressurePeak: 0.96,
    }));
    expect(bucket.costTier).toBe("expensive");
    expect(bucket.dominantWaste).toBe("contextPressurePeak");
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
      navigationOverhead: Number.NaN,
      mutationDiscoveryWaste: Number.NaN,
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
    const btFlag = flags.find((f) => f.metric === "aimlessBacktracks");
    expect(btFlag).toBeUndefined();
  });

  it("flags high backtracks as warn", () => {
    const flags = flagMetrics(baseMetrics({ aimlessBacktracks: 50 }));
    const btFlag = flags.find((f) => f.metric === "aimlessBacktracks");
    expect(btFlag).toBeDefined();
    expect(btFlag!.severity).toBe("warn");
  });

  it("flags critical backtracks", () => {
    const flags = flagMetrics(baseMetrics({ aimlessBacktracks: 100 }));
    const btFlag = flags.find((f) => f.metric === "aimlessBacktracks");
    expect(btFlag).toBeDefined();
    expect(btFlag!.severity).toBe("critical");
  });

  it("flags high TTCF as warn", () => {
    const flags = flagMetrics(baseMetrics({ timeToFirstCorrectFile: 0.35 }));
    const ttcfFlag = flags.find((f) => f.metric === "timeToFirstCorrectFile");
    expect(ttcfFlag).toBeDefined();
    expect(ttcfFlag!.severity).toBe("warn");
  });

  it("flags critical TTCF", () => {
    const flags = flagMetrics(baseMetrics({ timeToFirstCorrectFile: 0.55 }));
    const ttcfFlag = flags.find((f) => f.metric === "timeToFirstCorrectFile");
    expect(ttcfFlag).toBeDefined();
    expect(ttcfFlag!.severity).toBe("critical");
  });

  it("does not flag baseline context pressure (0.835)", () => {
    const flags = flagMetrics(baseMetrics({ contextPressurePeak: 0.835 }));
    const cpFlag = flags.find((f) => f.metric === "contextPressurePeak");
    expect(cpFlag).toBeUndefined();
  });

  it("flags elevated context pressure as warn", () => {
    const flags = flagMetrics(baseMetrics({ contextPressurePeak: 0.90 }));
    const cpFlag = flags.find((f) => f.metric === "contextPressurePeak");
    expect(cpFlag).toBeDefined();
    expect(cpFlag!.severity).toBe("warn");
  });

  it("skips NaN metrics", () => {
    const flags = flagMetrics(baseMetrics({
      timeToFirstCorrectFile: Number.NaN,
      navigationOverhead: Number.NaN,
      mutationDiscoveryWaste: Number.NaN,
    }));
    const nanMetrics = flags.filter((f) =>
      f.metric === "timeToFirstCorrectFile" || f.metric === "navigationOverhead" || f.metric === "mutationDiscoveryWaste"
    );
    expect(nanMetrics).toHaveLength(0);
  });

  it("flags multiple metrics at once", () => {
    const flags = flagMetrics(baseMetrics({
      timeToFirstCorrectFile: 0.6,
      aimlessBacktracks: 100,
      contextPressurePeak: 0.96,
    }));
    expect(flags.length).toBeGreaterThanOrEqual(3);
  });
});
