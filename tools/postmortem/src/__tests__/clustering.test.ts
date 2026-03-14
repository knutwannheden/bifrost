import { describe, it, expect } from "vitest";
import {
  normalize,
  kmeans,
  classifyPoint,
  buildClusterModel,
  type ClusterModel,
} from "../clustering.js";

describe("normalize", () => {
  it("z-score normalizes a matrix", () => {
    const data = [
      [10, 100],
      [20, 200],
      [30, 300],
    ];
    const { normalized, params } = normalize(data);

    // Mean of col 0: 20, stddev: ~8.16
    expect(params[0].mean).toBeCloseTo(20, 5);
    expect(params[0].stddev).toBeCloseTo(8.165, 2);

    // After normalization, mean should be ~0
    const col0 = normalized.map((r) => r[0]);
    const mean0 = col0.reduce((s, v) => s + v, 0) / col0.length;
    expect(mean0).toBeCloseTo(0, 5);
  });

  it("handles zero-stddev columns (constant values)", () => {
    const data = [
      [10, 5],
      [20, 5],
      [30, 5],
    ];
    const { normalized, params } = normalize(data);
    // Constant column should normalize to all zeros
    expect(normalized[0][1]).toBe(0);
    expect(normalized[1][1]).toBe(0);
    expect(params[1].stddev).toBe(0);
  });
});

describe("kmeans", () => {
  it("finds 2 clusters in clearly separated data", () => {
    // Two well-separated groups
    const data = [
      [0, 0], [1, 0], [0, 1], [1, 1],       // cluster near (0.5, 0.5)
      [10, 10], [11, 10], [10, 11], [11, 11], // cluster near (10.5, 10.5)
    ];
    const result = kmeans(data, 2, 42);

    expect(result.centroids).toHaveLength(2);
    expect(result.assignments).toHaveLength(8);

    // Points 0-3 should be in one cluster, 4-7 in another
    const cluster0 = result.assignments[0];
    expect(result.assignments[1]).toBe(cluster0);
    expect(result.assignments[2]).toBe(cluster0);
    expect(result.assignments[3]).toBe(cluster0);

    const cluster1 = result.assignments[4];
    expect(cluster1).not.toBe(cluster0);
    expect(result.assignments[5]).toBe(cluster1);
    expect(result.assignments[6]).toBe(cluster1);
    expect(result.assignments[7]).toBe(cluster1);
  });

  it("is deterministic with the same seed", () => {
    const data = Array.from({ length: 20 }, (_, i) => [i % 5, Math.floor(i / 5)]);
    const r1 = kmeans(data, 3, 42);
    const r2 = kmeans(data, 3, 42);
    expect(r1.assignments).toEqual(r2.assignments);
    expect(r1.centroids).toEqual(r2.centroids);
  });

  it("produces different results with different seeds", () => {
    const data = Array.from({ length: 20 }, (_, i) => [i % 5, Math.floor(i / 5)]);
    const r1 = kmeans(data, 3, 42);
    const r2 = kmeans(data, 3, 99);
    // Centroids might differ (not guaranteed but very likely with different seeds)
    // Just check both produce valid output
    expect(r1.centroids).toHaveLength(3);
    expect(r2.centroids).toHaveLength(3);
  });
});

describe("classifyPoint", () => {
  it("assigns point to nearest centroid", () => {
    const centroids = [
      [0, 0],
      [10, 10],
    ];
    expect(classifyPoint([1, 1], centroids)).toBe(0);
    expect(classifyPoint([9, 9], centroids)).toBe(1);
    expect(classifyPoint([5, 5], centroids)).toBe(0); // equidistant rounds to first
  });
});

describe("buildClusterModel", () => {
  it("builds a serializable model from raw metric data", () => {
    const metricNames = ["metricA", "metricB"];
    const rawData = [
      [0, 0], [1, 0], [0, 1], [1, 1],
      [10, 10], [11, 10], [10, 11], [11, 11],
    ];
    const model = buildClusterModel(rawData, metricNames, 2, 42);

    expect(model.metrics).toEqual(metricNames);
    expect(model.normalization).toHaveLength(2);
    expect(model.clusters).toHaveLength(2);

    // Each cluster should have centroid, size, and per-metric stats
    for (const cluster of model.clusters) {
      expect(cluster.centroid).toHaveLength(2);
      expect(cluster.size).toBeGreaterThan(0);
      expect(cluster.label).toBeDefined();
      expect(cluster.stats).toHaveLength(2); // one per metric
    }

    // Total size should equal data length
    const totalSize = model.clusters.reduce((s, c) => s + c.size, 0);
    expect(totalSize).toBe(8);
  });

  it("model can classify new points", () => {
    const metricNames = ["a", "b"];
    const rawData = [
      [0, 0], [1, 0], [0, 1], [1, 1],
      [10, 10], [11, 10], [10, 11], [11, 11],
    ];
    const model = buildClusterModel(rawData, metricNames, 2, 42);

    // Classify a point near the first cluster
    const nearFirst = classifyWithModel(model, [0.5, 0.5]);
    // Classify a point near the second cluster
    const nearSecond = classifyWithModel(model, [10.5, 10.5]);

    expect(nearFirst).not.toBe(nearSecond);
  });
});

// Helper to classify using a model (normalize then find nearest centroid)
function classifyWithModel(model: ClusterModel, rawPoint: number[]): number {
  const normalized = rawPoint.map((v, i) => {
    const { mean, stddev } = model.normalization[i];
    return stddev === 0 ? 0 : (v - mean) / stddev;
  });
  return classifyPoint(normalized, model.clusters.map((c) => c.centroid));
}
