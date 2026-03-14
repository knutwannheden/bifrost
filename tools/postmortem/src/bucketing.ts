import type { SessionMetrics, SessionBucket, MetricFlag, Severity, CostTier, ToolEvent } from "./types.js";

interface ThresholdDef {
  metric: keyof SessionMetrics;
  warn: number;
  critical: number;
  recommendation: string;
  /** Alternative recommendation when no tests were observed in the session */
  noTestRecommendation?: string;
}

const THRESHOLDS: ThresholdDef[] = [
  {
    metric: "timeToFirstCorrectFile",
    warn: 0.3,
    critical: 0.5,
    recommendation: "Inject a file map, tree output, or explicit file targets into CLAUDE.md or the prompt.",
  },
  {
    metric: "navigationOverhead",
    warn: 10,
    critical: 20,
    recommendation: "List target files in the prompt. Use .claude/rules/ to describe project structure.",
  },
  {
    metric: "aimlessBacktracks",
    warn: 2,
    critical: 4,
    recommendation: 'Add "run tests after each file change" to CLAUDE.md rules.',
    noTestRecommendation: "Add a verification step (lint, build, or manual check) after each file change. Break large edits into smaller, validated steps.",
  },
  {
    metric: "testCycleCount",
    warn: 3,
    critical: 6,
    recommendation: "Include expected behavior specs. Provide failing test output upfront.",
  },
  {
    metric: "contextPressurePeak",
    warn: 0.7,
    critical: 0.9,
    recommendation: "Decompose into smaller tasks. Use /compact proactively. Trim CLAUDE.md.",
  },
  {
    metric: "mutationDiscoveryWaste",
    warn: 0.4,
    critical: 0.7,
    recommendation: "Narrow task scope. Provide explicit file targets.",
  },
];

const COST_THRESHOLDS = { efficient: 500, moderate: 2000 };

/**
 * Classify a session into a cost tier + dominant waste type.
 * Pass events to enable context-aware recommendations.
 */
export function bucketSession(metrics: SessionMetrics, events?: ToolEvent[]): SessionBucket {
  const hasTests = events ? events.some((e) => e.category === "test") : true;

  // NaN cost means no diff — classify by other signals
  if (Number.isNaN(metrics.costPerDiffLine)) {
    return {
      costTier: "moderate",
      dominantWaste: "none",
      recommendation: "No diff available — cost efficiency cannot be determined. Review other metrics for waste signals.",
    };
  }

  const costTier: CostTier =
    metrics.costPerDiffLine < COST_THRESHOLDS.efficient
      ? "efficient"
      : metrics.costPerDiffLine < COST_THRESHOLDS.moderate
        ? "moderate"
        : "expensive";

  if (costTier === "efficient") {
    return { costTier, dominantWaste: "none", recommendation: "Efficient session. Archive prompt/CLAUDE.md as template." };
  }

  // Find which metric is most above its warn threshold (normalized severity)
  let dominant: keyof SessionMetrics | "none" = "none";
  let maxSeverity = 1;

  for (const def of THRESHOLDS) {
    const value = metrics[def.metric];
    if (Number.isNaN(value)) continue; // skip unavailable metrics
    const severity = value / def.warn;
    if (severity > maxSeverity) {
      maxSeverity = severity;
      dominant = def.metric;
    }
  }

  let rec: string;
  if (dominant === "none") {
    rec = "Cost is elevated but no single metric dominates. Review session transcript for unusual patterns.";
  } else {
    const def = THRESHOLDS.find((t) => t.metric === dominant)!;
    rec = (!hasTests && def.noTestRecommendation) ? def.noTestRecommendation : def.recommendation;
  }

  return { costTier, dominantWaste: dominant, recommendation: rec };
}

/**
 * Flag individual metrics that exceed their warn or critical thresholds.
 * Pass events to enable context-aware recommendations.
 */
export function flagMetrics(metrics: SessionMetrics, events?: ToolEvent[]): MetricFlag[] {
  const flags: MetricFlag[] = [];
  const hasTests = events ? events.some((e) => e.category === "test") : true;

  for (const def of THRESHOLDS) {
    const value = metrics[def.metric];
    if (Number.isNaN(value)) continue; // skip unavailable metrics

    let severity: Severity = "ok";

    if (value >= def.critical) {
      severity = "critical";
    } else if (value >= def.warn) {
      severity = "warn";
    }

    if (severity !== "ok") {
      const rec = (!hasTests && def.noTestRecommendation) ? def.noTestRecommendation : def.recommendation;
      flags.push({
        metric: def.metric,
        value,
        severity,
        recommendation: rec,
      });
    }
  }

  return flags;
}
