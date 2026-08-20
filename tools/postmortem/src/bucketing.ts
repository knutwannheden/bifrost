import type { CostTier, MetricFlag, SessionBucket, SessionMetrics, Severity, ToolEvent } from './types.js';

interface ThresholdDef {
  metric: keyof SessionMetrics;
  warn: number;
  critical: number;
  recommendation: string;
  noTestRecommendation?: string;
}

// Thresholds calibrated against 30 real sessions (2026-03-14 CV + correlation analysis).
// Only metrics surviving the CV > 0.3 and |r| < 0.7 filters have thresholds.
const THRESHOLDS: ThresholdDef[] = [
  {
    metric: 'timeToFirstCorrectFile',
    warn: 0.3,
    critical: 0.5,
    // CV=2.16. Discovery phase. High variance but rarely triggers (Claude finds files fast).
    recommendation: 'Inject a file map, tree output, or explicit file targets into CLAUDE.md or the prompt.',
  },
  {
    metric: 'aimlessBacktracks',
    warn: 40,
    critical: 80,
    // CV=0.93. Iteration phase. Observed range: 13-393, median 55.5.
    recommendation: 'Add "run tests after each file change" to CLAUDE.md rules.',
    noTestRecommendation:
      'Add a verification step (lint, build, or manual check) after each file change. Break large edits into smaller, validated steps.',
  },
  {
    metric: 'testCycleCount',
    warn: 3,
    critical: 6,
    // CV=2.03. Iteration phase. 60% ok, 15% warn, 25% critical.
    recommendation: 'Include expected behavior specs. Provide failing test output upfront.',
  },
  {
    metric: 'editWithoutReadRate',
    warn: 0.3,
    critical: 0.6,
    // CV=0.95. Iteration phase. Mean 0.21, range 0-0.73.
    recommendation: "Agent is editing files without reading them first. Add 'always read before editing' to CLAUDE.md.",
  },
  {
    metric: 'humanCorrectionDensity',
    warn: 15,
    critical: 25,
    // CV=0.61. Quality phase. Mean 9.6, range ~1-25.
    recommendation: 'Agent needs frequent human steering. Provide clearer specs, break into smaller tasks.',
  },
  {
    metric: 'toolErrorRate',
    warn: 0.05,
    critical: 0.1,
    // CV=0.61. Quality phase. Mean 0.042, range 0-0.1.
    recommendation: 'High tool error rate. Check for path issues, missing permissions, or environment problems.',
  },
  {
    metric: 'fileFocusScore',
    warn: 20,
    critical: 30,
    // CV=0.36. Focus phase. Mean 17.4, range 5-30.
    recommendation: 'Agent is scattered across too many files. Narrow the task scope or provide explicit file targets.',
  },
];

// Calibrated against 16 sessions with diffs. Median cost: 6,010; P25: 2,679; P75: 10,641.
const COST_THRESHOLDS = { efficient: 2500, moderate: 10000 };

/**
 * Classify a session into a cost tier + dominant waste type.
 */
export function bucketSession(metrics: SessionMetrics, events?: ToolEvent[]): SessionBucket {
  const hasTests = events ? events.some((e) => e.category === 'test') : true;

  if (Number.isNaN(metrics.costPerDiffLine)) {
    return {
      costTier: 'moderate',
      dominantWaste: 'none',
      recommendation:
        'No diff available — cost efficiency cannot be determined. Review other metrics for waste signals.',
    };
  }

  const costTier: CostTier =
    metrics.costPerDiffLine < COST_THRESHOLDS.efficient
      ? 'efficient'
      : metrics.costPerDiffLine < COST_THRESHOLDS.moderate
        ? 'moderate'
        : 'expensive';

  if (costTier === 'efficient') {
    return {
      costTier,
      dominantWaste: 'none',
      recommendation: 'Efficient session. Archive prompt/CLAUDE.md as template.',
    };
  }

  let dominant: keyof SessionMetrics | 'none' = 'none';
  let maxSeverity = 1;

  for (const def of THRESHOLDS) {
    const value = metrics[def.metric];
    if (Number.isNaN(value)) continue;
    const severity = value / def.warn;
    if (severity > maxSeverity) {
      maxSeverity = severity;
      dominant = def.metric;
    }
  }

  let rec: string;
  if (dominant === 'none') {
    rec = 'Cost is elevated but no single metric dominates. Review session transcript for unusual patterns.';
  } else {
    const def = THRESHOLDS.find((t) => t.metric === dominant)!;
    rec = !hasTests && def.noTestRecommendation ? def.noTestRecommendation : def.recommendation;
  }

  return { costTier, dominantWaste: dominant, recommendation: rec };
}

/**
 * Flag individual metrics that exceed their warn or critical thresholds.
 */
export function flagMetrics(metrics: SessionMetrics, events?: ToolEvent[]): MetricFlag[] {
  const flags: MetricFlag[] = [];
  const hasTests = events ? events.some((e) => e.category === 'test') : true;

  for (const def of THRESHOLDS) {
    const value = metrics[def.metric];
    if (Number.isNaN(value)) continue;

    let severity: Severity = 'ok';
    if (value >= def.critical) {
      severity = 'critical';
    } else if (value >= def.warn) {
      severity = 'warn';
    }

    if (severity !== 'ok') {
      const rec = !hasTests && def.noTestRecommendation ? def.noTestRecommendation : def.recommendation;
      flags.push({ metric: def.metric, value, severity, recommendation: rec });
    }
  }

  return flags;
}
