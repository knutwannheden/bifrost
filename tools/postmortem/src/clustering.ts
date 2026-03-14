/**
 * K-means clustering with z-score normalization and seeded PRNG.
 *
 * Designed to produce a serializable ClusterModel that can classify
 * new sessions without re-running the full clustering.
 */

export interface NormParam {
  mean: number;
  stddev: number;
}

export interface ClusterStats {
  /** Mean of raw (unnormalized) values for this metric within the cluster */
  mean: number;
  /** Stddev of raw values for this metric within the cluster */
  stddev: number;
}

export interface ClusterInfo {
  /** Centroid in normalized (z-score) space */
  centroid: number[];
  /** Number of sessions in this cluster */
  size: number;
  /** Auto-generated label from dominant metrics */
  label: string;
  /** Per-metric stats (raw space) for sessions in this cluster */
  stats: ClusterStats[];
}

export interface ClusterModel {
  /** Ordered metric names corresponding to vector dimensions */
  metrics: string[];
  /** Z-score normalization parameters per dimension */
  normalization: NormParam[];
  /** Cluster definitions */
  clusters: ClusterInfo[];
  /** Seed used for reproducibility */
  seed: number;
}

export interface KMeansResult {
  centroids: number[][];
  assignments: number[];
}

// --- Seeded PRNG (mulberry32) ---

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Z-score normalization ---

export function normalize(data: number[][]): { normalized: number[][]; params: NormParam[] } {
  const dims = data[0].length;
  const n = data.length;
  const params: NormParam[] = [];

  for (let d = 0; d < dims; d++) {
    const col = data.map((row) => row[d]);
    const mean = col.reduce((s, v) => s + v, 0) / n;
    const variance = col.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);
    params.push({ mean, stddev });
  }

  const normalized = data.map((row) =>
    row.map((v, d) => (params[d].stddev === 0 ? 0 : (v - params[d].mean) / params[d].stddev)),
  );

  return { normalized, params };
}

// --- K-means with k-means++ initialization ---

export function kmeans(data: number[][], k: number, seed = 42, maxIter = 100): KMeansResult {
  const rand = mulberry32(seed);
  const n = data.length;
  const dims = data[0].length;

  // K-means++ initialization
  const centroids: number[][] = [];
  // Pick first centroid randomly
  centroids.push([...data[Math.floor(rand() * n)]]);

  for (let c = 1; c < k; c++) {
    // Compute distance from each point to nearest existing centroid
    const dists = data.map((point) => {
      let minDist = Number.POSITIVE_INFINITY;
      for (const centroid of centroids) {
        const d = euclideanDistSq(point, centroid);
        if (d < minDist) minDist = d;
      }
      return minDist;
    });

    // Weighted random selection proportional to distance²
    const totalDist = dists.reduce((s, d) => s + d, 0);
    let r = rand() * totalDist;
    let idx = 0;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    centroids.push([...data[idx]]);
  }

  // Iterate
  let assignments = new Array<number>(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign points to nearest centroid
    const newAssignments = data.map((point) => classifyPoint(point, centroids));

    // Check convergence
    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;
    if (!changed && iter > 0) break;

    // Recompute centroids
    for (let c = 0; c < k; c++) {
      const members = data.filter((_, i) => assignments[i] === c);
      if (members.length === 0) continue;

      for (let d = 0; d < dims; d++) {
        centroids[c][d] = members.reduce((s, p) => s + p[d], 0) / members.length;
      }
    }
  }

  return { centroids, assignments };
}

export function classifyPoint(point: number[], centroids: number[][]): number {
  let bestIdx = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < centroids.length; i++) {
    const d = euclideanDistSq(point, centroids[i]);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function euclideanDistSq(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return sum;
}

// --- Model building ---

/**
 * Build a ClusterModel from raw metric data.
 * Normalizes, clusters, and stores everything needed to classify new sessions.
 */
export function buildClusterModel(
  rawData: number[][],
  metricNames: string[],
  k: number,
  seed = 42,
): ClusterModel {
  const { normalized, params } = normalize(rawData);
  const { centroids, assignments } = kmeans(normalized, k, seed);

  // Build per-cluster stats in raw space
  const clusters: ClusterInfo[] = centroids.map((centroid, clusterIdx) => {
    const memberIndices = assignments
      .map((a, i) => (a === clusterIdx ? i : -1))
      .filter((i) => i >= 0);

    const size = memberIndices.length;
    const stats: ClusterStats[] = metricNames.map((_, metricIdx) => {
      const values = memberIndices.map((i) => rawData[i][metricIdx]);
      if (values.length === 0) return { mean: 0, stddev: 0 };
      const mean = values.reduce((s, v) => s + v, 0) / values.length;
      const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
      return { mean, stddev: Math.sqrt(variance) };
    });

    // Auto-label from metrics where centroid is > 0.5 stddev above overall mean
    const elevated = metricNames.filter((_, i) => centroid[i] > 0.5);
    const depressed = metricNames.filter((_, i) => centroid[i] < -0.5);
    const label = generateLabel(elevated, depressed);

    return { centroid: [...centroid], size, label, stats };
  });

  return { metrics: metricNames, normalization: params, clusters, seed };
}

const METRIC_SHORT_NAMES: Record<string, string> = {
  timeToFirstCorrectFile: "slow discovery",
  aimlessBacktracks: "thrashing",
  testCycleCount: "test churn",
  editWithoutReadRate: "blind edits",
  humanCorrectionDensity: "high steering",
  toolErrorRate: "error-prone",
  fileFocusScore: "scattered",
};

const METRIC_LOW_NAMES: Record<string, string> = {
  timeToFirstCorrectFile: "fast discovery",
  aimlessBacktracks: "focused edits",
  testCycleCount: "few test cycles",
  editWithoutReadRate: "careful reads",
  humanCorrectionDensity: "autonomous",
  toolErrorRate: "low errors",
  fileFocusScore: "focused files",
};

function generateLabel(elevated: string[], depressed: string[]): string {
  const parts: string[] = [];

  for (const m of elevated) {
    parts.push(METRIC_SHORT_NAMES[m] || m);
  }

  if (parts.length === 0) {
    // Use depressed metrics for the label
    for (const m of depressed.slice(0, 2)) {
      parts.push(METRIC_LOW_NAMES[m] || `low ${m}`);
    }
  }

  if (parts.length === 0) return "Average";
  // Capitalize first letter
  const label = parts.join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
