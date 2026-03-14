import { describe, it, expect } from "vitest";
import { bucketSession, flagMetrics } from "../bucketing.js";
import type { SessionMetrics } from "../types.js";

function baseMetrics(overrides: Partial<SessionMetrics> = {}): SessionMetrics {
  return {
    costPerDiffLine: 100,
    timeToFirstCorrectFile: 0.1,
    navigationOverhead: 3,
    aimlessBacktracks: 0,
    testCycleCount: 1,
    contextPressurePeak: 0.3,
    mutationDiscoveryWaste: 0.1,
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
      costPerDiffLine: 1000,
      timeToFirstCorrectFile: 0.6,
    }));
    expect(bucket.costTier).toBe("moderate");
    expect(bucket.dominantWaste).toBe("timeToFirstCorrectFile");
  });

  it("classifies expensive session with high backtracks", () => {
    const bucket = bucketSession(baseMetrics({
      costPerDiffLine: 3000,
      aimlessBacktracks: 5,
    }));
    expect(bucket.costTier).toBe("expensive");
    expect(bucket.dominantWaste).toBe("aimlessBacktracks");
  });

  it("classifies expensive session with high context pressure", () => {
    const bucket = bucketSession(baseMetrics({
      costPerDiffLine: 2500,
      contextPressurePeak: 0.95,
    }));
    expect(bucket.costTier).toBe("expensive");
    expect(bucket.dominantWaste).toBe("contextPressurePeak");
  });

  it("returns none for dominant waste when no metric exceeds warn", () => {
    const bucket = bucketSession(baseMetrics({ costPerDiffLine: 1500 }));
    expect(bucket.costTier).toBe("moderate");
    expect(bucket.dominantWaste).toBe("none");
  });
});

describe("flagMetrics", () => {
  it("returns no flags for healthy metrics", () => {
    const flags = flagMetrics(baseMetrics());
    expect(flags).toHaveLength(0);
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

  it("flags multiple metrics at once", () => {
    const flags = flagMetrics(baseMetrics({
      timeToFirstCorrectFile: 0.6,
      aimlessBacktracks: 5,
      contextPressurePeak: 0.95,
    }));
    expect(flags.length).toBeGreaterThanOrEqual(3);
  });
});
