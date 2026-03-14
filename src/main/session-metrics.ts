import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flagMetrics } from '../../tools/postmortem/src/bucketing';
import {
  extractTokenTimeline,
  extractToolEvents,
  parseClaudeTranscript,
} from '../../tools/postmortem/src/claude-parser';
import { type ClusterModel, classifyPoint } from '../../tools/postmortem/src/clustering';
import { parseDiff } from '../../tools/postmortem/src/diff-parser';
import { computeMetrics } from '../../tools/postmortem/src/metrics';
import type { SessionMetricEntry, SessionMetricsResult } from '../shared/types';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function projectDirName(worktreePath: string): string {
  return worktreePath.replace(/[/.]/g, '-');
}

const METRIC_LABELS: Record<string, string> = {
  costPerDiffLine: 'Cost per diff line',
  timeToFirstCorrectFile: 'Time to first correct file',
  aimlessBacktracks: 'Aimless backtracks',
  testCycleCount: 'Test cycle count',
  editWithoutReadRate: 'Edit-without-read rate',
  humanCorrectionDensity: 'Human correction density',
  toolErrorRate: 'Tool error rate',
  fileFocusScore: 'File focus score',
};

const CLUSTER_METRICS = [
  'timeToFirstCorrectFile',
  'aimlessBacktracks',
  'testCycleCount',
  'editWithoutReadRate',
  'humanCorrectionDensity',
  'toolErrorRate',
  'fileFocusScore',
] as const;

// Import cluster model as a JSON module (bundled by Vite)
import clusterModelJson from '../../tools/postmortem/cluster-model.json';

const clusterModel: ClusterModel | null = clusterModelJson as unknown as ClusterModel;

// Simple cache to avoid recomputing on every request
const cache = new Map<string, { lineCount: number; result: SessionMetricsResult }>();

export function getSessionMetricsData(worktreePath: string, sessionId?: string): SessionMetricsResult {
  const empty: SessionMetricsResult = { metrics: [], cluster: null, backtrackDetail: [] };

  // Find the JSONL file
  const dirName = projectDirName(worktreePath);
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, dirName);
  if (!fs.existsSync(projectDir)) return empty;

  let jsonlPath: string | null = null;
  if (sessionId) {
    const candidate = path.join(projectDir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) jsonlPath = candidate;
  }
  if (!jsonlPath) {
    // Fall back to most recently modified JSONL
    try {
      const files = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) jsonlPath = path.join(projectDir, files[0].name);
    } catch {
      return empty;
    }
  }
  if (!jsonlPath) return empty;

  // Check cache
  const text = fs.readFileSync(jsonlPath, 'utf-8');
  const lineCount = text.split('\n').length;
  const cacheKey = jsonlPath;
  const cached = cache.get(cacheKey);
  if (cached && cached.lineCount === lineCount) return cached.result;

  // Parse transcript
  const entries = parseClaudeTranscript(text);
  const events = extractToolEvents(entries);
  const tokenTimeline = extractTokenTimeline(entries);

  // Generate diff (try git diff against default branch)
  let diffText = '';
  try {
    diffText = execFileSync('git', ['-C', worktreePath, 'diff', 'main'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
  } catch {
    // No diff available — metrics depending on diff will be NaN
  }
  const diffSummary = parseDiff(diffText);

  // Compute metrics
  const metrics = computeMetrics(events, tokenTimeline, diffSummary, 200_000, entries);
  const flags = flagMetrics(metrics, events);

  // Build metric entries
  const flagMap = new Map(flags.map((f) => [f.metric, f.severity]));
  const metricEntries: SessionMetricEntry[] = [];

  for (const [name, label] of Object.entries(METRIC_LABELS)) {
    const value = metrics[name as keyof typeof metrics];
    if (typeof value !== 'number') continue;
    if (Number.isNaN(value)) continue;

    // Compute z-score if model is available
    let zScore = 0;
    if (clusterModel) {
      const metricIdx = clusterModel.metrics.indexOf(name);
      if (metricIdx >= 0) {
        const param = clusterModel.normalization[metricIdx];
        zScore = param.stddev === 0 ? 0 : (value - param.mean) / param.stddev;
      }
    }

    metricEntries.push({
      name,
      label,
      value,
      zScore,
      flag: (flagMap.get(name as keyof typeof metrics) as 'ok' | 'warn' | 'critical') ?? 'ok',
    });
  }

  // Classify against cluster model
  let cluster: SessionMetricsResult['cluster'] = null;
  if (clusterModel) {
    const vector = CLUSTER_METRICS.map((m) => {
      const v = metrics[m];
      return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
    });
    const normalized = vector.map((v, i) => {
      const p = clusterModel!.normalization[i];
      return p.stddev === 0 ? 0 : (v - p.mean) / p.stddev;
    });
    const centroids = clusterModel.clusters.map((c) => c.centroid);
    const clusterIdx = classifyPoint(normalized, centroids);
    const distances = centroids.map((c) => {
      let sum = 0;
      for (let i = 0; i < normalized.length; i++) sum += (normalized[i] - c[i]) ** 2;
      return Math.sqrt(sum);
    });

    cluster = {
      index: clusterIdx,
      label: clusterModel.clusters[clusterIdx].label,
      distances,
    };
  }

  const backtrackDetail = metrics.backtrackDetail.slice(0, 5);

  const result: SessionMetricsResult = { metrics: metricEntries, cluster, backtrackDetail };

  // Update cache
  cache.set(cacheKey, { lineCount, result });

  return result;
}
