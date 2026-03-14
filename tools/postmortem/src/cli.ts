#!/usr/bin/env bun
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, basename, join } from "node:path";
import minimist from "minimist";
import { parseClaudeTranscript, extractToolEvents, extractTokenTimeline } from "./claude-parser.js";
import { parseDiff } from "./diff-parser.js";
import { computeMetrics } from "./metrics.js";
import { bucketSession, flagMetrics } from "./bucketing.js";
import { segmentSubTasks } from "./segmentation.js";
import { formatTextReport, formatJsonReport } from "./report.js";
import type { SessionReport, SubagentSummary, ToolEvent, TokenTimeline } from "./types.js";

const USAGE = `
Usage: postmortem [options]

Options:
  --transcript <path>   Path to Claude Code JSONL transcript file
  --diff <path>         Path to unified diff file
  --repo <path>         Path to git repo (auto-generates diff with --base)
  --base <ref>          Git ref to diff against (default: HEAD~1)
  --context-window <n>  Context window size (default: 200000)
  --json                Output as JSON
  --help                Show this help
`.trim();

function main() {
  const args = minimist(process.argv.slice(2), {
    string: ["transcript", "diff", "repo", "base"],
    boolean: ["json", "help"],
    default: { base: "HEAD~1", "context-window": 200000 },
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

  // Get diff
  let diffText: string;
  if (args.diff) {
    const diffPath = resolve(args.diff);
    if (!existsSync(diffPath)) {
      console.error(`Error: diff file not found: ${diffPath}`);
      process.exit(1);
    }
    diffText = readFileSync(diffPath, "utf-8");
  } else if (args.repo) {
    const repoPath = resolve(args.repo);
    try {
      diffText = execFileSync("git", ["-C", repoPath, "diff", args.base], { encoding: "utf-8" });
    } catch (e) {
      console.error(`Error: failed to generate git diff: ${(e as Error).message}`);
      process.exit(1);
    }
  } else {
    console.error("Error: either --diff or --repo is required");
    console.error(USAGE);
    process.exit(1);
  }

  const contextWindowSize = Number(args["context-window"]) || 200000;

  // Parse main transcript
  const entries = parseClaudeTranscript(transcriptText);
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
    const entries = parseClaudeTranscript(text);
    const events = extractToolEvents(entries);
    const timeline = extractTokenTimeline(entries);

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
