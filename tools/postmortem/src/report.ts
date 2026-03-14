import type { SessionReport, SessionMetrics, MetricFlag, Severity, SubTask } from "./types.js";

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

  // Sub-task breakdown (skip empty sub-tasks)
  const nonEmpty = report.subTasks.filter((st) => st.events.length > 0 || st.tokenTimeline.turns.length > 0);
  if (nonEmpty.length > 1) {
    lines.push("");
    lines.push(`=== Sub-task Breakdown (${nonEmpty.length} of ${report.subTasks.length}) ===`);
    for (let i = 0; i < nonEmpty.length; i++) {
      lines.push("");
      lines.push(formatSubTask(i + 1, nonEmpty[i]));
    }
  }

  return lines.join("\n");
}

/**
 * Format a session report as JSON.
 */
export function formatJsonReport(report: SessionReport): string {
  return JSON.stringify(report, null, 2);
}

function formatSubTask(num: number, st: SubTask): string {
  const lines: string[] = [];
  const prompt = st.promptText.length > 80 ? `${st.promptText.slice(0, 77)}...` : st.promptText;
  lines.push(`--- Sub-task ${num}: ${prompt} ---`);
  lines.push(`  Classification: ${st.bucket.costTier.toUpperCase()}${st.bucket.dominantWaste !== "none" ? ` (${METRIC_LABELS[st.bucket.dominantWaste] || st.bucket.dominantWaste})` : ""}`);
  lines.push(`  Events: ${st.events.length}  Turns: ${st.tokenTimeline.turns.length}  Tokens: ${st.tokenTimeline.totalInputTokens.toLocaleString()} in / ${st.tokenTimeline.totalOutputTokens.toLocaleString()} out`);

  // Compact metrics — only show flagged ones
  if (st.flags.length > 0) {
    for (const flag of st.flags) {
      const label = METRIC_LABELS[flag.metric] || flag.metric;
      lines.push(`  [${flag.severity.toUpperCase()}] ${label}: ${formatValue(flag.metric, flag.value)}`);
    }
  }

  return lines.join("\n");
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
