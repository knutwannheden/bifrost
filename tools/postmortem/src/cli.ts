#!/usr/bin/env npx tsx
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import minimist from "minimist";
import { parseClaudeTranscript, extractToolEvents, extractTokenTimeline } from "./claude-parser.js";
import { parseDiff } from "./diff-parser.js";
import { computeMetrics } from "./metrics.js";
import { bucketSession, flagMetrics } from "./bucketing.js";
import { segmentSubTasks } from "./segmentation.js";
import { formatTextReport, formatJsonReport } from "./report.js";
import type { SessionReport } from "./types.js";

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
      diffText = execSync(`git -C ${repoPath} diff ${args.base}`, { encoding: "utf-8" });
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

  // Parse
  const entries = parseClaudeTranscript(transcriptText);
  const events = extractToolEvents(entries);
  const tokenTimeline = extractTokenTimeline(entries);
  const diffSummary = parseDiff(diffText);

  // Compute
  const metrics = computeMetrics(events, tokenTimeline, diffSummary, contextWindowSize);
  const bucket = bucketSession(metrics);
  const flags = flagMetrics(metrics);

  // Sub-task segmentation
  const subTasks = segmentSubTasks(entries, events, diffSummary, contextWindowSize);

  const report: SessionReport = {
    metrics,
    bucket,
    flags,
    tokenTimeline,
    diffSummary,
    subTasks,
  };

  // Output
  if (args.json) {
    console.log(formatJsonReport(report));
  } else {
    console.log(formatTextReport(report));
  }
}

main();
