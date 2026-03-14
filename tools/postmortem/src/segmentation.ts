import type { TranscriptEntry } from "./claude-parser.js";
import { extractTokenTimeline } from "./claude-parser.js";
import type { ToolEvent, TokenTimeline, DiffSummary, SubTask } from "./types.js";
import { computeMetrics } from "./metrics.js";
import { bucketSession, flagMetrics } from "./bucketing.js";

interface PromptBoundary {
  index: number;
  timestamp: string;
  promptText: string;
}

/**
 * Segment a session into sub-tasks at human prompt boundaries.
 * Returns empty array if the session has only one human prompt (no breakdown needed).
 */
export function segmentSubTasks(
  entries: TranscriptEntry[],
  events: ToolEvent[],
  diff: DiffSummary,
  contextWindowSize = 200_000,
): SubTask[] {
  const boundaries = findPromptBoundaries(entries);

  // No segmentation for single-prompt sessions
  if (boundaries.length <= 1) return [];

  const subTasks: SubTask[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const boundary = boundaries[i];
    const nextBoundary = boundaries[i + 1];

    const startTime = boundary.timestamp;
    const endTime = nextBoundary?.timestamp;

    // Split events by timestamp range
    const subEvents = events.filter((e) => {
      const t = e.timestamp;
      if (t < startTime) return false;
      if (endTime && t >= endTime) return false;
      return true;
    });

    // Split entries by index range for token timeline
    const startIdx = boundary.index;
    const endIdx = nextBoundary?.index ?? entries.length;
    const subEntries = entries.slice(startIdx, endIdx);
    const tokenTimeline = extractTokenTimeline(subEntries);

    const metrics = computeMetrics(subEvents, tokenTimeline, diff, contextWindowSize);
    const bucket = bucketSession(metrics, subEvents);
    const flags = flagMetrics(metrics, subEvents);

    subTasks.push({
      promptText: boundary.promptText,
      startIndex: startIdx,
      endIndex: endIdx,
      events: subEvents,
      tokenTimeline,
      metrics,
      bucket,
      flags,
    });
  }

  return subTasks;
}

function findPromptBoundaries(entries: TranscriptEntry[]): PromptBoundary[] {
  const boundaries: PromptBoundary[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as TranscriptEntry & { userType?: string };
    if (entry.type !== "user" || entry.userType !== "external") continue;

    const text = extractPromptText(entry);
    if (!text) continue;

    // Skip non-human messages
    if (text.startsWith("[Request interrupted")) continue;
    if (text.startsWith("<local-command-caveat>")) continue;
    if (text.startsWith("<bash-input>")) continue;
    if (text.startsWith("<bash-stdout>")) continue;
    if (text.startsWith("<bash-stderr>")) continue;
    if (text.startsWith("<command-name>")) continue;
    if (text.startsWith("<local-command-stdout>")) continue;

    boundaries.push({
      index: i,
      timestamp: entry.timestamp || "",
      promptText: text,
    });
  }

  return boundaries;
}

function extractPromptText(entry: TranscriptEntry): string | null {
  const content = entry.message?.content;

  // Plain string content
  if (typeof content === "string") return content;

  // Array of blocks — check for text blocks (not tool_result)
  if (Array.isArray(content)) {
    const blocks = content as Array<Record<string, unknown>>;
    const hasToolResult = blocks.some((b) => b.type === "tool_result");
    if (hasToolResult) return null;

    const textParts = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text as string);

    return textParts.length > 0 ? textParts.join("\n") : null;
  }

  return null;
}
