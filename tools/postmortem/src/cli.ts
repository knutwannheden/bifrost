#!/usr/bin/env bun
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename, join } from "node:path";
import minimist from "minimist";
import { parseClaudeTranscript, extractToolEvents, extractTokenTimeline } from "./claude-parser.js";
import type { TranscriptEntry } from "./claude-parser.js";
import { parseDiff } from "./diff-parser.js";
import { computeMetrics } from "./metrics.js";
import { bucketSession, flagMetrics } from "./bucketing.js";
import { segmentSubTasks } from "./segmentation.js";
import { formatTextReport, formatJsonReport } from "./report.js";
import type { SessionReport, SubagentSummary, ToolEvent, TokenTimeline } from "./types.js";

const USAGE = `
Usage: postmortem --transcript <path> [options]

The transcript's cwd and time range are used to auto-generate a diff
from git commits made during the session. Override with --diff or --base.

Options:
  --transcript <path>   Path to Claude Code JSONL transcript file
  --diff <path>         Path to a pre-generated unified diff file
  --base <ref>          Git ref to diff against (instead of auto-detecting)
  --context-window <n>  Context window size (default: 200000)
  --json                Output as JSON
  --help                Show this help
`.trim();

function main() {
  const args = minimist(process.argv.slice(2), {
    string: ["transcript", "diff", "base"],
    boolean: ["json", "help"],
    default: { "context-window": 200000 },
    alias: { h: "help" },
  });

  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }

  if (!args.transcript) {
    console.error("Error: --transcript is required");
    console.error(USAGE);
    process.exit(1);
  }

  // Read transcript
  const transcriptPath = resolve(args.transcript);
  if (!existsSync(transcriptPath)) {
    console.error(`Error: transcript file not found: ${transcriptPath}`);
    process.exit(1);
  }
  const transcriptText = readFileSync(transcriptPath, "utf-8");

  // Parse main transcript (needed for cwd/timestamp extraction)
  const entries = parseClaudeTranscript(transcriptText);

  // Get diff
  const diffText = resolveDiff(args, entries);
  const contextWindowSize = Number(args["context-window"]) || 200000;

  const events = extractToolEvents(entries);
  const tokenTimeline = extractTokenTimeline(entries);
  const diffSummary = parseDiff(diffText);

  // Discover and merge subagent transcripts
  const { mergedEvents, mergedTimeline, subagents } = mergeSubagents(
    transcriptPath, events, tokenTimeline,
  );

  // Compute metrics using merged data (main + subagents)
  const metrics = computeMetrics(mergedEvents, mergedTimeline, diffSummary, contextWindowSize);
  const bucket = bucketSession(metrics, mergedEvents);
  const flags = flagMetrics(metrics, mergedEvents);

  // Sub-task segmentation (uses main entries only for prompt boundaries)
  const subTasks = segmentSubTasks(entries, mergedEvents, diffSummary, contextWindowSize);

  const report: SessionReport = {
    metrics,
    bucket,
    flags,
    tokenTimeline: mergedTimeline,
    diffSummary,
    subTasks,
    subagents,
  };

  // Output
  if (args.json) {
    console.log(formatJsonReport(report));
  } else {
    console.log(formatTextReport(report));
  }
}

/**
 * Resolve the diff text from CLI args or by auto-detecting from the transcript.
 *
 * Priority:
 * 1. --diff <file>: use the provided diff file
 * 2. --base <ref>: diff cwd (from transcript) against that ref
 * 3. Auto-detect: find commits in cwd within the session's time range
 */
function resolveDiff(args: minimist.ParsedArgs, entries: TranscriptEntry[]): string {
  // 1. Explicit diff file
  if (args.diff) {
    const diffPath = resolve(args.diff);
    if (!existsSync(diffPath)) {
      console.error(`Error: diff file not found: ${diffPath}`);
      process.exit(1);
    }
    return readFileSync(diffPath, "utf-8");
  }

  // Extract cwd from transcript
  const cwd = extractCwd(entries);
  if (!cwd) {
    console.error("Error: no cwd found in transcript. Provide --diff explicitly.");
    process.exit(1);
  }

  // 2. Explicit base ref
  if (args.base) {
    try {
      return execFileSync("git", ["-C", cwd, "diff", args.base], { encoding: "utf-8" });
    } catch (e) {
      console.error(`Error: git diff failed: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // 3. Auto-detect: find commits within session time range
  const { startTime, endTime } = extractTimeRange(entries);
  if (!startTime) {
    console.error("Error: no timestamps in transcript. Provide --diff or --base.");
    process.exit(1);
  }

  try {
    // Find commits in the session's time range
    const logOutput = execFileSync("git", [
      "-C", cwd, "log", "--oneline", "--format=%H",
      `--after=${startTime}`, `--before=${endTime}`,
    ], { encoding: "utf-8" }).trim();

    if (!logOutput) {
      // No commits in range — return empty diff
      return "";
    }

    const commits = logOutput.split("\n");
    const firstCommit = commits[commits.length - 1]; // oldest
    const lastCommit = commits[0]; // newest

    // Diff from parent of first commit to last commit
    return execFileSync("git", ["-C", cwd, "diff", `${firstCommit}~1`, lastCommit], { encoding: "utf-8" });
  } catch {
    // Git command failed — return empty diff
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
    const events = extractToolEvents(subEntries);
    const timeline = extractTokenTimeline(subEntries);

    allSubEvents = allSubEvents.concat(events);
    subTotalInput += timeline.totalInputTokens;
    subTotalOutput += timeline.totalOutputTokens;
    subCostWeighted += timeline.totalCostWeightedTokens;
    summary.count++;
  }

  summary.totalInputTokens = subTotalInput;
  summary.totalOutputTokens = subTotalOutput;
  summary.totalEvents = allSubEvents.length;

  // Merge events sorted by timestamp
  const mergedEvents = [...mainEvents, ...allSubEvents].sort(
    (a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""),
  );

  // Merge timelines
  const mergedTimeline: TokenTimeline = {
    turns: [...mainTimeline.turns],
    totalInputTokens: mainTimeline.totalInputTokens + subTotalInput,
    totalOutputTokens: mainTimeline.totalOutputTokens + subTotalOutput,
    totalCostWeightedTokens: mainTimeline.totalCostWeightedTokens + subCostWeighted,
  };

  return { mergedEvents, mergedTimeline, subagents: summary };
}

main();
