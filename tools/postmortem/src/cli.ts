#!/usr/bin/env bun
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename, join } from "node:path";
import minimist from "minimist";
import { parseClaudeTranscript, extractToolEvents, extractTokenTimeline } from "./claude-parser.js";
import type { TranscriptEntry } from "./claude-parser.js";
import { parseDiff } from "./diff-parser.js";
import { computeMetrics } from "./metrics.js";
import { bucketSession, flagMetrics } from "./bucketing.js";
import { segmentSubTasks } from "./segmentation.js";
import { buildClusterModel, classifyPoint, type ClusterModel } from "./clustering.js";
import { formatTextReport, formatJsonReport } from "./report.js";
import type { SessionReport, SessionMetrics, SubagentSummary, ToolEvent, TokenTimeline } from "./types.js";

const USAGE = `
Usage: postmortem <mode> [options]

Modes:
  --transcript <path>   Analyze a single session
  --batch <dir>         Cluster sessions from a directory of JSONL files
  --classify <path>     Classify a session against a saved cluster model

Single session options:
  --diff <path>         Path to a pre-generated unified diff file
  --base <ref>          Git ref to diff against (instead of auto-detecting)
  --context-window <n>  Context window size (default: 200000)

Batch clustering options:
  --k <n>               Number of clusters (default: 3)
  --seed <n>            Random seed for deterministic clustering (default: 42)
  --model <path>        Save/load cluster model JSON (default: cluster-model.json)
  --min-lines <n>       Min JSONL lines to include a session (default: 100)

Common options:
  --json                Output as JSON
  --help                Show this help
`.trim();

// --- Metric vector extraction ---

/** The 7 clustering dimensions in canonical order */
const CLUSTER_METRICS: (keyof SessionMetrics)[] = [
  "timeToFirstCorrectFile",
  "aimlessBacktracks",
  "testCycleCount",
  "editWithoutReadRate",
  "humanCorrectionDensity",
  "toolErrorRate",
  "fileFocusScore",
];

function metricsToVector(metrics: SessionMetrics): number[] {
  return CLUSTER_METRICS.map((key) => {
    const v = metrics[key];
    // Replace NaN with 0 for clustering (NaN means no diff, treat as neutral)
    return typeof v === "number" && !Number.isNaN(v) ? v : 0;
  });
}

// --- Main ---

function main() {
  const args = minimist(process.argv.slice(2), {
    string: ["transcript", "diff", "base", "batch", "classify", "model"],
    boolean: ["json", "help"],
    default: { "context-window": 200000, k: 3, seed: 42, "min-lines": 100, model: "cluster-model.json" },
    alias: { h: "help" },
  });

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (args.batch) {
    runBatch(args);
  } else if (args.classify) {
    runClassify(args);
  } else if (args.transcript) {
    runSingle(args);
  } else {
    console.error("Error: provide --transcript, --batch, or --classify");
    console.error(USAGE);
    process.exit(1);
  }
}

// --- Single session analysis ---

function runSingle(args: minimist.ParsedArgs) {
  const transcriptPath = resolve(args.transcript);
  if (!existsSync(transcriptPath)) {
    console.error(`Error: transcript file not found: ${transcriptPath}`);
    process.exit(1);
  }
  const transcriptText = readFileSync(transcriptPath, "utf-8");
  const entries = parseClaudeTranscript(transcriptText);
  const diffText = resolveDiff(args, entries);
  const contextWindowSize = Number(args["context-window"]) || 200000;

  const events = extractToolEvents(entries);
  const tokenTimeline = extractTokenTimeline(entries);
  const diffSummary = parseDiff(diffText);

  const { mergedEvents, mergedTimeline, subagents } = mergeSubagents(transcriptPath, events, tokenTimeline);
  const metrics = computeMetrics(mergedEvents, mergedTimeline, diffSummary, contextWindowSize, entries);
  const bucket = bucketSession(metrics, mergedEvents);
  const flags = flagMetrics(metrics, mergedEvents);
  const subTasks = segmentSubTasks(entries, mergedEvents, diffSummary, contextWindowSize);

  const report: SessionReport = {
    metrics, bucket, flags, tokenTimeline: mergedTimeline, diffSummary, subTasks, subagents,
  };

  if (args.json) {
    console.log(formatJsonReport(report));
  } else {
    console.log(formatTextReport(report));
  }
}

// --- Batch clustering ---

function runBatch(args: minimist.ParsedArgs) {
  const batchDir = resolve(args.batch);
  const k = Number(args.k) || 3;
  const seed = Number(args.seed) || 42;
  const modelPath = resolve(args.model);
  const minLines = Number(args["min-lines"]) || 100;

  // Find JSONL files
  const jsonlFiles = findJsonlFiles(batchDir, minLines);
  if (jsonlFiles.length < k) {
    console.error(`Error: found ${jsonlFiles.length} sessions, need at least ${k} for k=${k} clusters`);
    process.exit(1);
  }

  console.error(`Found ${jsonlFiles.length} sessions, clustering into ${k} groups (seed=${seed})...`);

  // Collect metrics
  const sessionData: Array<{ path: string; metrics: SessionMetrics; vector: number[] }> = [];

  for (const file of jsonlFiles) {
    try {
      const text = readFileSync(file, "utf-8");
      const entries = parseClaudeTranscript(text);
      const events = extractToolEvents(entries);
      const tokenTimeline = extractTokenTimeline(entries);
      const diffText = resolveDiff({ diff: undefined, base: undefined }, entries);
      const diffSummary = parseDiff(diffText);
      const { mergedEvents, mergedTimeline } = mergeSubagents(file, events, tokenTimeline);
      const metrics = computeMetrics(mergedEvents, mergedTimeline, diffSummary, 200000, entries);
      sessionData.push({ path: file, metrics, vector: metricsToVector(metrics) });
    } catch {
      // Skip sessions that fail to parse
    }
  }

  console.error(`Successfully collected metrics from ${sessionData.length} sessions.`);

  if (sessionData.length < k) {
    console.error(`Error: only ${sessionData.length} sessions parsed successfully, need at least ${k}`);
    process.exit(1);
  }

  // Build cluster model
  const rawData = sessionData.map((s) => s.vector);
  const model = buildClusterModel(rawData, CLUSTER_METRICS as string[], k, seed);

  // Save model
  writeFileSync(modelPath, JSON.stringify(model, null, 2));
  console.error(`Model saved to ${modelPath}`);

  // Classify each session
  const normalizedSessions = sessionData.map((s) => ({
    ...s,
    normalizedVector: s.vector.map((v, i) => {
      const p = model.normalization[i];
      return p.stddev === 0 ? 0 : (v - p.mean) / p.stddev;
    }),
  }));

  // Output
  if (args.json) {
    const output = {
      model,
      sessions: normalizedSessions.map((s) => ({
        path: s.path,
        cluster: classifyPoint(s.normalizedVector, model.clusters.map((c) => c.centroid)),
        metrics: s.metrics,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Text report grouped by cluster
    for (let c = 0; c < model.clusters.length; c++) {
      const cluster = model.clusters[c];
      const members = normalizedSessions.filter(
        (s) => classifyPoint(s.normalizedVector, model.clusters.map((cl) => cl.centroid)) === c,
      );

      console.log(`\n=== Cluster ${c + 1}: ${cluster.label} (${members.length} sessions) ===`);
      console.log(`  Centroid: ${CLUSTER_METRICS.map((m, i) => `${m}=${cluster.stats[i].mean.toFixed(1)}`).join(", ")}`);

      for (const s of members) {
        const name = basename(s.path, ".jsonl").slice(0, 8);
        const project = basename(dirname(s.path)).replace(/^-Users-knut-git-/, "").replace(/--worktrees-.*/, "");
        const highlights = CLUSTER_METRICS
          .map((m, i) => ({ name: m, value: s.vector[i], z: s.normalizedVector[i] }))
          .filter((h) => Math.abs(h.z) > 0.5)
          .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
          .slice(0, 3)
          .map((h) => `${h.name}=${formatMetricValue(h.name, h.value)}`)
          .join("  ");
        console.log(`  ${name}  (${project})  ${highlights}`);
      }
    }
  }
}

function formatMetricValue(metric: string, value: number): string {
  if (metric === "timeToFirstCorrectFile" || metric === "editWithoutReadRate" || metric === "toolErrorRate") {
    return `${(value * 100).toFixed(0)}%`;
  }
  if (metric === "humanCorrectionDensity") return `${value.toFixed(1)}/100`;
  return `${Math.round(value)}`;
}

// --- Classify against saved model ---

function runClassify(args: minimist.ParsedArgs) {
  const transcriptPath = resolve(args.classify);
  const modelPath = resolve(args.model);

  if (!existsSync(modelPath)) {
    console.error(`Error: model file not found: ${modelPath}. Run --batch first.`);
    process.exit(1);
  }
  if (!existsSync(transcriptPath)) {
    console.error(`Error: transcript not found: ${transcriptPath}`);
    process.exit(1);
  }

  const model: ClusterModel = JSON.parse(readFileSync(modelPath, "utf-8"));
  const text = readFileSync(transcriptPath, "utf-8");
  const entries = parseClaudeTranscript(text);
  const events = extractToolEvents(entries);
  const tokenTimeline = extractTokenTimeline(entries);
  const diffText = resolveDiff({ diff: undefined, base: undefined }, entries);
  const diffSummary = parseDiff(diffText);
  const { mergedEvents, mergedTimeline } = mergeSubagents(transcriptPath, events, tokenTimeline);
  const metrics = computeMetrics(mergedEvents, mergedTimeline, diffSummary, 200000, entries);
  const vector = metricsToVector(metrics);

  // Normalize using model params
  const normalized = vector.map((v, i) => {
    const p = model.normalization[i];
    return p.stddev === 0 ? 0 : (v - p.mean) / p.stddev;
  });

  const clusterIdx = classifyPoint(normalized, model.clusters.map((c) => c.centroid));
  const cluster = model.clusters[clusterIdx];

  // Compute distance to each cluster for confidence
  const distances = model.clusters.map((c) => {
    let sum = 0;
    for (let i = 0; i < normalized.length; i++) sum += (normalized[i] - c.centroid[i]) ** 2;
    return Math.sqrt(sum);
  });

  if (args.json) {
    console.log(JSON.stringify({ cluster: clusterIdx, label: cluster.label, distances, metrics }, null, 2));
  } else {
    console.log(`Cluster: ${clusterIdx + 1} — ${cluster.label}`);
    console.log(`Distance to clusters: ${distances.map((d, i) => `${i + 1}:${d.toFixed(2)}`).join("  ")}`);
    console.log();
    for (let i = 0; i < model.metrics.length; i++) {
      const m = model.metrics[i];
      const v = vector[i];
      const z = normalized[i];
      const marker = Math.abs(z) > 1 ? (z > 0 ? "HIGH" : "LOW ") : "    ";
      console.log(`  [${marker}] ${m.padEnd(28)} ${formatMetricValue(m, v).padStart(8)}  (z=${z.toFixed(2)})`);
    }
  }
}

// --- Helpers ---

function findJsonlFiles(dir: string, minLines: number): string[] {
  const results: string[] = [];

  function scan(d: string, depth: number) {
    if (depth > 2) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "subagents") {
        scan(join(d, entry.name), depth + 1);
      } else if (entry.name.endsWith(".jsonl") && !entry.name.startsWith("agent-acompact-")) {
        const path = join(d, entry.name);
        const text = readFileSync(path, "utf-8");
        const lines = text.split("\n").filter((l) => l.trim()).length;
        if (lines >= minLines) results.push(path);
      }
    }
  }

  scan(dir, 0);
  return results;
}

function resolveDiff(args: minimist.ParsedArgs, entries: TranscriptEntry[]): string {
  if (args.diff) {
    const diffPath = resolve(args.diff);
    if (!existsSync(diffPath)) {
      console.error(`Error: diff file not found: ${diffPath}`);
      process.exit(1);
    }
    return readFileSync(diffPath, "utf-8");
  }

  const cwd = extractCwd(entries);
  if (!cwd) return "";

  if (args.base) {
    try {
      return execFileSync("git", ["-C", cwd, "diff", args.base], { encoding: "utf-8" });
    } catch {
      return "";
    }
  }

  const { startTime, endTime } = extractTimeRange(entries);
  if (!startTime) return "";

  try {
    const logOutput = execFileSync("git", [
      "-C", cwd, "log", "--oneline", "--format=%H",
      `--after=${startTime}`, `--before=${endTime}`,
    ], { encoding: "utf-8" }).trim();

    if (!logOutput) return "";

    const commits = logOutput.split("\n");
    const firstCommit = commits[commits.length - 1];
    const lastCommit = commits[0];
    return execFileSync("git", ["-C", cwd, "diff", `${firstCommit}~1`, lastCommit], { encoding: "utf-8" });
  } catch {
    return "";
  }
}

function extractCwd(entries: TranscriptEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.cwd) return entry.cwd;
  }
  return undefined;
}

function extractTimeRange(entries: TranscriptEntry[]): { startTime?: string; endTime?: string } {
  let startTime: string | undefined;
  let endTime: string | undefined;
  for (const entry of entries) {
    if (entry.timestamp) {
      if (!startTime) startTime = entry.timestamp;
      endTime = entry.timestamp;
    }
  }
  return { startTime, endTime };
}

function mergeSubagents(
  transcriptPath: string,
  mainEvents: ToolEvent[],
  mainTimeline: TokenTimeline,
): { mergedEvents: ToolEvent[]; mergedTimeline: TokenTimeline; subagents: SubagentSummary } {
  const sessionId = basename(transcriptPath, ".jsonl");
  const subagentsDir = join(dirname(transcriptPath), sessionId, "subagents");

  const summary: SubagentSummary = { count: 0, totalInputTokens: 0, totalOutputTokens: 0, totalEvents: 0 };

  if (!existsSync(subagentsDir)) {
    return { mergedEvents: mainEvents, mergedTimeline: mainTimeline, subagents: summary };
  }

  let allSubEvents: ToolEvent[] = [];
  let subTotalInput = 0;
  let subTotalOutput = 0;
  let subCostWeighted = 0;

  const files = readdirSync(subagentsDir).filter(
    (f) => f.endsWith(".jsonl") && !f.startsWith("agent-acompact-"),
  );

  for (const file of files) {
    const text = readFileSync(join(subagentsDir, file), "utf-8");
    const subEntries = parseClaudeTranscript(text);
    const subEvents = extractToolEvents(subEntries);
    const timeline = extractTokenTimeline(subEntries);

    allSubEvents = allSubEvents.concat(subEvents);
    subTotalInput += timeline.totalInputTokens;
    subTotalOutput += timeline.totalOutputTokens;
    subCostWeighted += timeline.totalCostWeightedTokens;
    summary.count++;
  }

  summary.totalInputTokens = subTotalInput;
  summary.totalOutputTokens = subTotalOutput;
  summary.totalEvents = allSubEvents.length;

  const mergedEvents = [...mainEvents, ...allSubEvents].sort(
    (a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""),
  );

  const mergedTimeline: TokenTimeline = {
    turns: [...mainTimeline.turns],
    totalInputTokens: mainTimeline.totalInputTokens + subTotalInput,
    totalOutputTokens: mainTimeline.totalOutputTokens + subTotalOutput,
    totalCostWeightedTokens: mainTimeline.totalCostWeightedTokens + subCostWeighted,
  };

  return { mergedEvents, mergedTimeline, subagents: summary };
}

main();
