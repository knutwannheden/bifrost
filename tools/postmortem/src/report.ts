import type { SessionReport, MetricFlag, Severity } from "./types.js";

const METRIC_LABELS: Record<string, string> = {
  costPerDiffLine: "Cost per diff line",
  timeToFirstCorrectFile: "Time to first correct file",
  navigationOverhead: "Navigation overhead",
  aimlessBacktracks: "Aimless backtracks",
  testCycleCount: "Test cycle count",
  contextPressurePeak: "Context pressure peak",
  mutationDiscoveryWaste: "Mutation discovery waste",
};

const SEVERITY_MARKERS: Record<Severity, string> = {
  ok: " ",
  warn: "!",
  critical: "X",
};

/**
 * Format a session report as human-readable text.
 */
export function formatTextReport(report: SessionReport): string {
  const lines: string[] = [];

  // Header
  lines.push("=== Postmortem Analysis ===");
  lines.push("");

  // Classification
  const { bucket } = report;
  lines.push(`Classification: ${bucket.costTier.toUpperCase()}`);
  if (bucket.dominantWaste !== "none") {
    lines.push(`Dominant waste:  ${METRIC_LABELS[bucket.dominantWaste] || bucket.dominantWaste}`);
  }
  lines.push(`Recommendation:  ${bucket.recommendation}`);
  lines.push("");

  // Metrics table
  lines.push("--- Metrics ---");
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    const value = report.metrics[key as keyof typeof report.metrics];
    const flag = report.flags.find((f) => f.metric === key);
    const marker = flag ? SEVERITY_MARKERS[flag.severity] : " ";
    lines.push(`[${marker}] ${label.padEnd(30)} ${formatValue(key, value)}`);
  }
  lines.push("");

  // Flags detail
  if (report.flags.length > 0) {
    lines.push("--- Flags ---");
    for (const flag of report.flags) {
      const label = METRIC_LABELS[flag.metric] || flag.metric;
      lines.push(`[${flag.severity.toUpperCase()}] ${label}: ${formatValue(flag.metric, flag.value)}`);
      lines.push(`  -> ${flag.recommendation}`);
    }
    lines.push("");
  }

  // Token summary
  const tl = report.tokenTimeline;
  lines.push("--- Tokens ---");
  lines.push(`Total input:  ${tl.totalInputTokens.toLocaleString()}`);
  lines.push(`Total output: ${tl.totalOutputTokens.toLocaleString()}`);
  lines.push(`Turns:        ${tl.turns.length}`);
  lines.push("");

  // Diff summary
  const ds = report.diffSummary;
  lines.push("--- Diff ---");
  lines.push(`Files changed: ${ds.files.length}`);
  lines.push(`Lines added:   ${ds.totalAdded}`);
  lines.push(`Lines removed: ${ds.totalRemoved}`);

  return lines.join("\n");
}

/**
 * Format a session report as JSON.
 */
export function formatJsonReport(report: SessionReport): string {
  return JSON.stringify(report, null, 2);
}

function formatValue(metric: string, value: number): string {
  if (value === Number.POSITIVE_INFINITY) return "Infinity";
  if (metric === "timeToFirstCorrectFile" || metric === "contextPressurePeak" || metric === "mutationDiscoveryWaste") {
    return `${(value * 100).toFixed(1)}%`;
  }
  if (metric === "costPerDiffLine") {
    return `${value.toFixed(0)} tokens/line`;
  }
  return `${value}`;
}
